import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { buildApi } from '../src/api/server.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('instance definition linkage', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('records definitionId/versionNo and exposes timestamps', () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const store = new InstanceStore(dbPath);
    stores.push(store);
    store.createInstance('i1', 'n', '<xml/>', { definitionId: 'def-1', versionNo: 3 });
    const row = store.getInstance('i1')!;
    expect(row.definitionId).toBe('def-1');
    expect(row.versionNo).toBe(3);
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
    // linkage is optional — M1/M2 callers unchanged
    store.createInstance('i2', 'n', '<xml/>');
    expect(store.getInstance('i2')!.definitionId).toBeNull();
    // migration guard: reopening the same DB must not throw
    const again = new InstanceStore(dbPath);
    stores.push(again);
    expect(again.getInstance('i1')!.versionNo).toBe(3);
  });
});

describe('definition metrics', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  function seed() {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    // two finished runs, one aborted, one still running
    for (const [id, status] of [
      ['a', 'completed'],
      ['b', 'terminated'],
      ['c', 'aborted'],
      ['d', 'running'],
    ] as const) {
      store.createInstance(id, 'rfp', '<xml/>', { definitionId: 'def-1', versionNo: 1 });
      if (status !== 'running') store.setStatus(id, status);
    }
    // unrelated definition must not leak in
    store.createInstance('x', 'other', '<xml/>', { definitionId: 'def-2', versionNo: 1 });
    // task executions with cost on run a
    const e1 = store.startTaskExecution('a', 'audit', 'agent', 1, {});
    store.finishTaskExecution(e1, { status: 'completed', output: {}, costUsd: 0.5 });
    const e2 = store.startTaskExecution('a', 'audit', 'agent', 2, {});
    store.finishTaskExecution(e2, { status: 'completed', output: {}, costUsd: 0.25 });
    const e3 = store.startTaskExecution('b', 'review', 'code', 1, {});
    store.finishTaskExecution(e3, { status: 'completed', output: {} });
    store.createIncident('c', 'audit', 'boom');
    return store;
  }

  it('aggregates runs, success rate, cost, and incidents per definition', () => {
    const m = seed().metricsForDefinition('def-1');
    expect(m.runs).toEqual({ total: 4, completed: 1, terminated: 1, aborted: 1, error: 0, active: 1 });
    expect(m.successRate).toBeCloseTo(2 / 3); // finished = completed+terminated+aborted+error
    expect(m.durationsMs).toHaveLength(2); // finished successfully only
    expect(m.costPerRun.find((r) => r.instanceId === 'a')!.costUsd).toBeCloseTo(0.75);
    expect(m.costPerTask).toEqual([
      { nodeId: 'audit', runs: 2, totalCostUsd: 0.75, avgDurationMs: expect.any(Number) },
      { nodeId: 'review', runs: 1, totalCostUsd: 0, avgDurationMs: expect.any(Number) },
    ]);
    expect(m.incidents).toEqual({ total: 1, open: 1 });
  });

  it('serves metrics over HTTP', async () => {
    const store = seed();
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    const app = buildApi({ store, host, inbox });
    const res = await app.inject({ method: 'GET', url: '/api/metrics/definitions/def-1' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs.total).toBe(4);
  });
});
