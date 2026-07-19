import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { DefinitionStore } from '../src/definitions/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
const MINIMAL = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><process id="p"/></definitions>';

function build() {
  const dbPath = path.join(tmp(), 'ff.db');
  const store = new InstanceStore(dbPath);
  const definitions = new DefinitionStore(dbPath);
  let inbox!: Inbox;
  const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
  inbox = new Inbox(store, host, { notify: async () => {} });
  const app = buildApi({ store, host, inbox, definitions });
  return { store, definitions, app };
}

describe('UI read routes', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('lists versions of a definition', async () => {
    const { store, definitions, app } = build();
    stores.push(store);
    const { id } = definitions.upload('rfp', MINIMAL);
    definitions.saveVersion(id, MINIMAL);
    const res = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions.map((v: any) => v.versionNo)).toEqual([1, 2]);
  });

  it('serves a transcript file by execution id', async () => {
    const { store, app } = build();
    stores.push(store);
    store.createInstance('i1', 'n', '<xml/>');
    const p = path.join(tmp(), 't.jsonl');
    writeFileSync(p, '{"hello":1}\n');
    const execId = store.startTaskExecution('i1', 'audit', 'agent', 1, {});
    store.finishTaskExecution(execId, { status: 'completed', output: {}, transcriptPath: p });
    const res = await app.inject({ method: 'GET', url: `/api/task-executions/${execId}/transcript` });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('hello');
    const missing = await app.inject({ method: 'GET', url: `/api/task-executions/9999/transcript` });
    expect(missing.statusCode).toBe(404);
  });
});
