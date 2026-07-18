import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function tmp(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

async function waitForEvent(store: InstanceStore, id: string, type: string, elementId: string) {
  for (let i = 0; i < 100; i++) {
    if (store.listEvents(id).some((e) => e.type === type && e.elementId === elementId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${type}:${elementId}`);
}

// Process variables live under the process EXECUTION environment (M2 dispatch
// spike finding — findings_m2-dispatch.md), not definitions[0].environment.
function varsOf(store: InstanceStore, id: string): Record<string, unknown> {
  const state = JSON.parse(store.getInstance(id)!.engineState!);
  return state.definitions[0].execution.processes[0].environment.variables;
}

describe('dry-run dispatch', () => {
  let store: InstanceStore;
  afterEach(() => store?.close());

  it('completes contracts.bpmn with stub output, override, and user signal', async () => {
    const dir = tmp();
    store = new InstanceStore(path.join(dir, 'ff.db'));
    const host = new EngineHost(store, { dataDir: dir });

    const running = host.start({
      id: 'd1',
      name: 'contracts',
      source,
      workspace: tmp(),
      dryRun: true,
      stubOverrides: { codeTask: { count: 5 } },
    });

    await waitForEvent(store, 'd1', 'activity.wait', 'userTask');
    host.signal('d1', 'userTask', { approved: true });
    await running;

    expect(store.getInstance('d1')?.status).toBe('completed');
    const vars = varsOf(store, 'd1');
    expect(vars.atRiskTasks).toEqual([]); // stub-derived from agentTask schema
    expect(vars.count).toBe(5); // per-node override
    expect(vars.approved).toBe(true); // user signal payload
  });

  it('persists workspace and dryRun on the instance row', async () => {
    const dir = tmp();
    store = new InstanceStore(path.join(dir, 'ff.db'));
    const host = new EngineHost(store, { dataDir: dir });
    const ws = tmp();
    const running = host.start({ id: 'd2', name: 'contracts', source, workspace: ws, dryRun: true });
    await waitForEvent(store, 'd2', 'activity.wait', 'userTask');
    const row = store.getInstance('d2')!;
    expect(row.workspace).toBe(ws);
    expect(row.dryRun).toBe(true);
    host.signal('d2', 'userTask', { approved: false });
    await running;
  });
});
