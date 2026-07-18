import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost } from '../src/grill/session.js';
import { buildApi } from '../src/api/server.js';
import type { AgentQueryFn } from '../src/runners/agent.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

const echoQuery: AgentQueryFn = ({ options }) =>
  (async function* () {
    yield { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } };
    yield { type: 'result', subtype: 'success', result: 'ok', session_id: 's-1', options };
  })();

function build() {
  const dir = tmp();
  const store = new InstanceStore(path.join(dir, 'ff.db'));
  const definitions = new DefinitionStore(path.join(dir, 'ff.db'));
  let inbox!: Inbox;
  const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const grill = new GrillHost({ definitions, queryFn: echoQuery });
  const app = buildApi({ store, host, inbox, definitions, grill });
  return { store, definitions, app };
}

describe('grill API', () => {
  const closers: Array<{ close(): void }> = [];
  afterEach(() => closers.forEach((s) => s.close()));

  it('creates a session, accepts messages, saves a version', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();

    const created = await app.inject({
      method: 'POST', url: '/api/grill/sessions', payload: { definitionId: id },
    });
    expect(created.statusCode).toBe(201);
    const { sessionId, lint } = created.json();
    expect(lint.deployable).toBe(false);

    const msg = await app.inject({
      method: 'POST', url: `/api/grill/sessions/${sessionId}/messages`, payload: { text: 'start' },
    });
    expect(msg.statusCode).toBe(202);

    const saved = await app.inject({
      method: 'POST', url: `/api/grill/sessions/${sessionId}/save-version`,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().versionNo).toBe(2);
    expect(definitions.getVersion(id, 2)).toBeDefined();
  });

  it('404s on unknown definition or session', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);
    const bad = await app.inject({
      method: 'POST', url: '/api/grill/sessions', payload: { definitionId: 'ghost' },
    });
    expect(bad.statusCode).toBe(404);
    const badMsg = await app.inject({
      method: 'POST', url: '/api/grill/sessions/ghost/messages', payload: { text: 'x' },
    });
    expect(badMsg.statusCode).toBe(404);
  });
});

describe('instances from stored versions', () => {
  const closers: Array<{ close(): void }> = [];
  afterEach(() => closers.forEach((s) => s.close()));

  it('starts a dry run from a deployable version and 400s on a non-deployable one', async () => {
    const { store, definitions, app } = build();
    closers.push(store, definitions);

    // deployable definition
    const dep = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'daily', xml: refined },
    })).json();
    await app.inject({ method: 'POST', url: `/api/definitions/${dep.id}/versions/1/lint` });
    const started = await app.inject({
      method: 'POST', url: '/api/instances',
      payload: { definitionId: dep.id, workspacePath: tmp(), dryRun: true,
                 inputs: { submissionDeadline: '2026-08-01' } },
    });
    expect(started.statusCode).toBe(201);
    expect(store.listInstances().at(-1)?.name).toBe('daily');

    // non-deployable definition
    const raw = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();
    await app.inject({ method: 'POST', url: `/api/definitions/${raw.id}/versions/1/lint` });
    const refused = await app.inject({
      method: 'POST', url: '/api/instances',
      payload: { definitionId: raw.id, workspacePath: tmp(), dryRun: true },
    });
    expect(refused.statusCode).toBe(400);
  });
});
