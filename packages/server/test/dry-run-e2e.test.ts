import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { buildApi } from '../src/api/server.js';

const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 150; i++) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('condition not reached');
}

function build() {
  const dir = tmp();
  const store = new InstanceStore(path.join(dir, 'ff.db'));
  const definitions = new DefinitionStore(path.join(dir, 'ff.db'));
  let inbox!: Inbox;
  const host = new EngineHost(store, { dataDir: dir, onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const app = buildApi({ store, host, inbox, definitions });
  return { store, definitions, inbox, app };
}

async function startFromVersion(app: any, payload: Record<string, unknown>): Promise<string> {
  const uploaded = (await app.inject({
    method: 'POST', url: '/api/definitions', payload: { name: 'daily', xml: refined },
  })).json();
  await app.inject({ method: 'POST', url: `/api/definitions/${uploaded.id}/versions/1/lint` });
  const started = await app.inject({
    method: 'POST', url: '/api/instances',
    payload: { definitionId: uploaded.id, ...payload },
  });
  expect(started.statusCode).toBe(201);
  return started.json().id;
}

describe('dry-run E2E of the refined daily loop (impl M3.6 mechanics)', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('init branch: stub sends token to user task, then terminate end -> status terminated', async () => {
    const { store, inbox, app } = build();
    stores.push(store);
    // stub default for containsInitializer is false -> init branch
    const id = await startFromVersion(app, {
      workspacePath: tmp(), dryRun: true, inputs: { submissionDeadline: '2026-08-01' },
    });

    const task = await until(() => inbox.listPending().find((t) => t.nodeId === 'provideDeadline'));
    await inbox.submit(task.id, { submissionDeadline: '2026-08-15' });

    await until(() => store.getInstance(id)?.status === 'terminated');
    const timeline = store.listTaskExecutions(id);
    expect(timeline.map((t) => t.nodeId)).toEqual(
      expect.arrayContaining(['checkInit', 'provideDeadline', 'updateTracker']),
    );
  });

  it('audit loop: override steers past init, user task steers the loop, 2nd iteration reached (dry-run cycle)', async () => {
    const { store, inbox, app } = build();
    stores.push(store);
    const id = await startFromVersion(app, {
      workspacePath: tmp(), dryRun: true,
      inputs: { submissionDeadline: '2026-08-01' },
      stubOverrides: { checkInit: { containsInitializer: true } },
    });

    // iteration 1: audit runs, review continues the loop
    const review1 = await until(() => inbox.listPending().find((t) => t.nodeId === 'reviewCycle'));
    await inbox.submit(review1.id, { continueLoop: true });

    // timer (PT2S) fires, iteration 2: audit runs again, review exits the loop
    const review2 = await until(() =>
      inbox.listPending().find((t) => t.nodeId === 'reviewCycle' && t.id !== review1.id),
    );
    await inbox.submit(review2.id, { continueLoop: false });

    await until(() => store.getInstance(id)?.status === 'completed');
    const audits = store.listTaskExecutions(id).filter((t) => t.nodeId === 'auditTracker');
    expect(audits).toHaveLength(2); // timer loop reached the second iteration
    const timerEvents = store.listEvents(id).filter(
      (e) => e.type === 'activity.timer' && e.elementId === 'wait24h',
    );
    expect(timerEvents.length).toBeGreaterThanOrEqual(1);
  });
});
