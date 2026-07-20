import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const failure = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

const alwaysFail: TaskRunner = {
  async run(): Promise<RunResult> {
    throw new Error('induced');
  },
};

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

function build(runner?: TaskRunner) {
  const d = createDaemon({
    dataDir: tmp(),
    ...(runner ? { runners: { agent: runner, code: runner } } : {}),
  });
  daemons.push(d);
  return d;
}

async function post(app: any, url: string, payload: unknown) {
  return app.inject({ method: 'POST', url, payload });
}

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('condition not reached');
}

describe('REST API', () => {

  it('drives a dry run end-to-end over HTTP', async () => {
    const { store, app } = build();
    const created = await post(app, '/api/instances', {
      name: 'contracts', source: contracts, workspacePath: tmp(),
      dryRun: true, inputs: { deadline: '2026-08-01' },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();

    // poll the inbox over HTTP (not the store) — this test exercises the API path
    let userTask: any;
    for (let i = 0; i < 100 && !userTask; i++) {
      const res = await app.inject({ method: 'GET', url: '/api/inbox' });
      userTask = res.json().userTasks[0];
      if (!userTask) await sleep(100);
    }
    expect(userTask.nodeId).toBe('userTask');

    const submit = await post(app, `/api/user-tasks/${userTask.id}/submit`, { vars: { approved: true } });
    expect(submit.statusCode).toBe(204);

    await until(() => store.getInstance(id)?.status === 'completed');
    const detail = await app.inject({ method: 'GET', url: `/api/instances/${id}` });
    const body = detail.json();
    expect(body.instance.status).toBe('completed');
    expect(body.timeline).toHaveLength(3);
    expect(body.events.length).toBeGreaterThan(0);
  });

  it('rejects invalid form submissions with 400', async () => {
    const { app } = build();
    await post(app, '/api/instances', { name: 'c', source: contracts, workspacePath: tmp(), dryRun: true });
    let userTask: any;
    for (let i = 0; i < 100 && !userTask; i++) {
      userTask = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().userTasks[0];
      if (!userTask) await sleep(100);
    }
    const bad = await post(app, `/api/user-tasks/${userTask.id}/submit`, { vars: { approved: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });

  it('enforces one active instance per workspace with 409 (FR-10)', async () => {
    const { app } = build();
    const ws = tmp();
    const first = await post(app, '/api/instances', { name: 'a', source: contracts, workspacePath: ws, dryRun: true });
    expect(first.statusCode).toBe(201);
    const second = await post(app, '/api/instances', { name: 'b', source: contracts, workspacePath: ws, dryRun: true });
    expect(second.statusCode).toBe(409);
  });

  it('exposes incidents in the inbox and resolves them over HTTP', async () => {
    const { store, app } = build(alwaysFail);
    await post(app, '/api/instances', { name: 'f', source: failure, workspacePath: tmp() });
    let incident: any;
    for (let i = 0; i < 100 && !incident; i++) {
      incident = (await app.inject({ method: 'GET', url: '/api/inbox' })).json().incidents[0];
      if (!incident) await sleep(100);
    }
    const res = await post(app, `/api/incidents/${incident.id}/resolve`, { action: 'skip', output: { ok: true } });
    expect(res.statusCode).toBe(204);
    await until(() => store.listOpenIncidents().length === 0);
  });

  it('streams events over SSE', async () => {
    const { app } = build();
    await app.listen({ port: 0 });
    const controller = new AbortController();
    try {
      const port = (app.server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/events`, { signal: controller.signal });
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = res.body!.getReader();
      await post(app, '/api/instances', { name: 'sse', source: contracts, workspacePath: tmp(), dryRun: true });
      // First chunk may be the ": connected" preamble; drain until a data event.
      const decoder = new TextDecoder();
      let stream = '';
      for (let i = 0; i < 20 && !stream.includes('data:'); i++) {
        const { value, done } = await reader.read();
        if (done) break;
        stream += decoder.decode(value);
      }
      expect(stream).toContain('data:');
    } finally {
      // Drop the live SSE connection so afterEach's d.close() can't hang on it.
      controller.abort();
    }
  });
});
