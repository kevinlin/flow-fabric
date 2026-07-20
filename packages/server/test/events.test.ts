import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { Events, type EmittedEvent } from '../src/events/events.js';
import type {
  InstanceEndTelemetry,
  TaskExecutionTelemetry,
  Telemetry,
} from '../src/telemetry/telemetry.js';

function fakeTelemetry(enabled = true) {
  const calls = {
    tasks: [] as TaskExecutionTelemetry[],
    instances: [] as InstanceEndTelemetry[],
    incidents: [] as string[],
  };
  const telemetry: Telemetry = {
    enabled,
    taskExecution: (t) => void calls.tasks.push(t),
    instanceEnded: (t) => void calls.instances.push(t),
    incidentRaised: (nodeId) => void calls.incidents.push(nodeId),
    flush: async () => {},
    shutdown: async () => {},
  };
  return { telemetry, calls };
}

describe('Events module', () => {
  let dir: string;
  let store: InstanceStore;
  let events: Events;
  let calls: ReturnType<typeof fakeTelemetry>['calls'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
    store = new InstanceStore(path.join(dir, 'db.sqlite'));
    const fake = fakeTelemetry();
    calls = fake.calls;
    events = new Events(store, fake.telemetry);
    store.createInstance('inst-1', 'run', '<xml/>', { definitionId: 'def-1', versionNo: 2 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe('append + subscribe (SSE fan-out)', () => {
    it('persists via the port and fans out the materialized event', () => {
      const received: EmittedEvent[] = [];
      events.subscribe((e) => received.push(e));
      events.append({ instanceId: 'inst-1', type: 'activity.start', elementId: 'Task_a' });

      // persisted
      const rows = store.listEvents('inst-1');
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ type: 'activity.start', elementId: 'Task_a' });
      // fanned out with the seq from the insert + null-normalized fields
      expect(received).toHaveLength(1);
      expect(received[0]).toMatchObject({
        instanceId: 'inst-1',
        seq: rows[0].seq,
        type: 'activity.start',
        elementId: 'Task_a',
        detail: null,
      });
      expect(typeof received[0].ts).toBe('number');
    });

    it('filters delivery by instanceId', () => {
      store.createInstance('inst-2', 'run2', '<xml/>');
      const forOne: EmittedEvent[] = [];
      events.subscribe((e) => forOne.push(e), { instanceId: 'inst-1' });
      events.append({ instanceId: 'inst-2', type: 'activity.start' });
      events.append({ instanceId: 'inst-1', type: 'activity.start' });
      expect(forOne).toHaveLength(1);
      expect(forOne[0].instanceId).toBe('inst-1');
    });

    it('unsubscribe stops delivery', () => {
      const received: EmittedEvent[] = [];
      const off = events.subscribe((e) => received.push(e));
      events.append({ instanceId: 'inst-1', type: 'a' });
      off();
      events.append({ instanceId: 'inst-1', type: 'b' });
      expect(received.map((e) => e.type)).toEqual(['a']);
    });
  });

  describe('instanceEnded (dedup + span assembly)', () => {
    it('fires telemetry once per instance with the event log from the port', () => {
      events.append({ instanceId: 'inst-1', type: 'activity.start', elementId: 'Task_a' });
      store.setStatus('inst-1', 'terminated');
      events.instanceEnded('inst-1', 'terminated');
      events.instanceEnded('inst-1', 'aborted'); // dedup: no second span
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

    it('skips unknown rows', () => {
      events.instanceEnded('does-not-exist', 'completed');
      expect(calls.instances).toHaveLength(0);
    });
  });

  describe('taskExecution (reads the row via the port)', () => {
    it('forwards the full execution record', () => {
      const id = store.startTaskExecution('inst-1', 'Task_a', 'agent', 2, { deadline: 'x' });
      store.finishTaskExecution(id, {
        status: 'completed',
        output: { ok: true },
        tokenUsage: { input_tokens: 5 },
        costUsd: 0.07,
      });
      events.taskExecution(id);
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

    it('carries failure errors', () => {
      const id = store.startTaskExecution('inst-1', 'Task_a', 'code', 1, {});
      store.finishTaskExecution(id, { status: 'failed', error: 'boom' });
      events.taskExecution(id);
      expect(calls.tasks[0]).toMatchObject({ status: 'failed', error: 'boom' });
    });

    it('skips unknown records', () => {
      events.taskExecution(9999);
      expect(calls.tasks).toHaveLength(0);
    });
  });

  describe('incidentRaised', () => {
    it('forwards the node id', () => {
      events.incidentRaised('Task_flaky');
      expect(calls.incidents).toEqual(['Task_flaky']);
    });
  });

  describe('disabled telemetry', () => {
    it('drives no telemetry driver when telemetry is not enabled', () => {
      const fake = fakeTelemetry(false);
      const inert = new Events(store, fake.telemetry);
      const id = store.startTaskExecution('inst-1', 'Task_a', 'agent', 1, {});
      store.finishTaskExecution(id, { status: 'completed' });
      store.setStatus('inst-1', 'completed');
      inert.taskExecution(id);
      inert.instanceEnded('inst-1', 'completed');
      inert.incidentRaised('Task_a');
      expect(fake.calls.tasks).toHaveLength(0);
      expect(fake.calls.instances).toHaveLength(0);
      expect(fake.calls.incidents).toHaveLength(0);
    });

    it('still fans out events regardless of telemetry', () => {
      const fake = fakeTelemetry(false);
      const inert = new Events(store, fake.telemetry);
      const received: EmittedEvent[] = [];
      inert.subscribe((e) => received.push(e));
      inert.append({ instanceId: 'inst-1', type: 'activity.start' });
      expect(received).toHaveLength(1);
    });
  });
});
