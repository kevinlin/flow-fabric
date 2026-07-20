import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
const MINIMAL = '<?xml version="1.0"?><definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL" id="d"><process id="p"/></definitions>';

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

function build() {
  const d = createDaemon({ dataDir: tmp() });
  daemons.push(d);
  return d;
}

describe('UI read routes', () => {

  it('lists versions of a definition', async () => {
    const { definitions, app } = build();
    const { id } = definitions.upload('rfp', MINIMAL);
    definitions.saveVersion(id, MINIMAL);
    const res = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions` });
    expect(res.statusCode).toBe(200);
    expect(res.json().versions.map((v: any) => v.versionNo)).toEqual([1, 2]);
  });

  it('serves a transcript file by execution id', async () => {
    const { store, app } = build();
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
