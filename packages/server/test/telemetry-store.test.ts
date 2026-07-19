import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import type {
  InstanceEndTelemetry,
  TaskExecutionTelemetry,
  Telemetry,
} from '../src/telemetry/telemetry.js';

function fakeTelemetry() {
  const calls = {
    tasks: [] as TaskExecutionTelemetry[],
    instances: [] as InstanceEndTelemetry[],
    incidents: [] as string[],
  };
  const telemetry: Telemetry = {
    enabled: true,
    taskExecution: (t) => void calls.tasks.push(t),
    instanceEnded: (t) => void calls.instances.push(t),
    incidentRaised: (nodeId) => void calls.incidents.push(nodeId),
    flush: async () => {},
    shutdown: async () => {},
  };
  return { telemetry, calls };
}

describe('InstanceStore telemetry seams', () => {
  let dir: string;
  let store: InstanceStore;
  let calls: ReturnType<typeof fakeTelemetry>['calls'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
    const fake = fakeTelemetry();
    calls = fake.calls;
    store = new InstanceStore(path.join(dir, 'db.sqlite'), { telemetry: fake.telemetry });
    store.createInstance('inst-1', 'run', '<xml/>', { definitionId: 'def-1', versionNo: 2 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finishTaskExecution emits the full execution record', () => {
    const id = store.startTaskExecution('inst-1', 'Task_a', 'agent', 2, { deadline: 'x' });
    store.finishTaskExecution(id, {
      status: 'completed',
      output: { ok: true },
      tokenUsage: { input_tokens: 5 },
      costUsd: 0.07,
    });
    expect(calls.tasks).toHaveLength(1);
    expect(calls.tasks[0]).toMatchObject({
      instanceId: 'inst-1',
      nodeId: 'Task_a',
      actor: 'agent',
      attempt: 2,
      status: 'completed',
      costUsd: 0.07,
    });
    expect(calls.tasks[0].endedAt).toBeGreaterThanOrEqual(calls.tasks[0].startedAt);
  });

  it('finishTaskExecution carries failure errors', () => {
    const id = store.startTaskExecution('inst-1', 'Task_a', 'code', 1, {});
    store.finishTaskExecution(id, { status: 'failed', error: 'boom' });
    expect(calls.tasks[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('terminal setStatus emits instanceEnded once, with the event log', () => {
    store.appendEvent('inst-1', 'activity.start', 'Task_a');
    store.setStatus('inst-1', 'terminated');
    store.setStatus('inst-1', 'aborted'); // double terminal write → no second span
    expect(calls.instances).toHaveLength(1);
    expect(calls.instances[0]).toMatchObject({
      instanceId: 'inst-1',
      name: 'run',
      status: 'terminated',
      definitionId: 'def-1',
      versionNo: 2,
      dryRun: false,
    });
    expect(calls.instances[0].events).toEqual([
      expect.objectContaining({ type: 'activity.start', elementId: 'Task_a' }),
    ]);
  });

  it('non-terminal setStatus emits nothing', () => {
    store.setStatus('inst-1', 'stopped');
    store.setStatus('inst-1', 'running');
    expect(calls.instances).toHaveLength(0);
  });

  it('createIncident emits the incident counter', () => {
    store.createIncident('inst-1', 'Task_flaky', 'boom');
    expect(calls.incidents).toEqual(['Task_flaky']);
  });
});
