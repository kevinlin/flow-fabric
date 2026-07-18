import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';
import type { Notifier } from '../src/notify/notifier.js';

const plain = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');
const withBoundary = plain.replace(
  '<!--BOUNDARY-->',
  `<boundaryEvent id="onErr" attachedToRef="flaky"><errorEventDefinition /></boundaryEvent>
   <sequenceFlow id="fErr" sourceRef="onErr" targetRef="endErr" />
   <endEvent id="endErr" />`,
);

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

/** Fails `failures` times, then succeeds with {ok:true}. Counts calls. */
class FlakyRunner implements TaskRunner {
  calls = 0;
  constructor(private failures: number) {}
  async run(): Promise<RunResult> {
    this.calls += 1;
    if (this.calls <= this.failures) throw new Error(`induced failure #${this.calls}`);
    return { output: { ok: true } };
  }
}

class MockNotifier implements Notifier {
  calls: string[] = [];
  async notify(title: string) {
    this.calls.push(title);
  }
}

function build(dbPath: string, runner: TaskRunner, notifier = new MockNotifier()) {
  const store = new InstanceStore(dbPath);
  const host = new EngineHost(store, {
    dataDir: path.dirname(dbPath),
    runners: { agent: runner, code: runner },
    notifier,
  });
  return { store, host, notifier };
}

async function waitForStatus(store: InstanceStore, id: string, status: string) {
  for (let i = 0; i < 100; i++) {
    if (store.getInstance(id)?.status === status) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for status ${status}, got ${store.getInstance(id)?.status}`);
}

describe('failure ladder', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('rung 1: retries within the attempt budget, then succeeds', async () => {
    const runner = new FlakyRunner(1); // fail once; retries=1 allows 2 attempts
    const { store, host } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    await host.start({ id: 'r1', name: 'failure', source: plain, workspace: tmp() });
    expect(store.getInstance('r1')?.status).toBe('completed');
    expect(runner.calls).toBe(2);
    expect(store.listOpenIncidents()).toHaveLength(0);
  });

  it('rung 2: exhausted retries route to the modeled error boundary', async () => {
    const runner = new FlakyRunner(Infinity);
    const { store, host } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    await host.start({ id: 'r2', name: 'failure', source: withBoundary, workspace: tmp() });
    expect(store.getInstance('r2')?.status).toBe('completed');
    expect(runner.calls).toBe(2); // retries=1 → 2 attempts, no more
    expect(store.listOpenIncidents()).toHaveLength(0);
    const ends = store.listEvents('r2').filter((e) => e.type === 'activity.end').map((e) => e.elementId);
    expect(ends).toContain('endErr');
    expect(ends).not.toContain('end');
  });

  it('rung 3: no boundary → incident raised, notified, token held', async () => {
    const runner = new FlakyRunner(Infinity);
    const { store, host, notifier } = build(path.join(tmp(), 'ff.db'), runner);
    stores.push(store);
    const running = host.start({ id: 'r3', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r3', 'incident');

    const [incident] = store.listOpenIncidents();
    expect(incident.nodeId).toBe('flaky');
    expect(incident.reason).toContain('induced failure');
    expect(notifier.calls.some((t) => t.includes('incident'))).toBe(true);

    // resolve: retry, with the runner now healthy
    runner.calls = 0;
    (runner as any).failures = 0;
    await host.resolveIncident(incident.id, 'retry');
    await running;
    expect(store.getInstance('r3')?.status).toBe('completed');
    expect(store.getIncident(incident.id)?.status).toBe('resolved');
  });

  it('skip validates the supplied output against the contract schema', async () => {
    const { store, host } = build(path.join(tmp(), 'ff.db'), new FlakyRunner(Infinity));
    stores.push(store);
    const running = host.start({ id: 'r4', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r4', 'incident');
    const [incident] = store.listOpenIncidents();

    await expect(host.resolveIncident(incident.id, 'skip', { wrong: 1 })).rejects.toThrow();
    expect(store.getIncident(incident.id)?.status).toBe('open');

    await host.resolveIncident(incident.id, 'skip', { ok: true });
    await running;
    expect(store.getInstance('r4')?.status).toBe('completed');
  });

  it('abort stops the engine and marks the instance aborted', async () => {
    const { store, host } = build(path.join(tmp(), 'ff.db'), new FlakyRunner(Infinity));
    stores.push(store);
    void host.start({ id: 'r5', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(store, 'r5', 'incident');
    const [incident] = store.listOpenIncidents();
    await host.resolveIncident(incident.id, 'abort');
    await waitForStatus(store, 'r5', 'aborted');
    expect(store.getIncident(incident.id)?.resolution).toBe('abort');
  });

  it('open incident survives restart: held again without re-running or re-notifying', async () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const runner1 = new FlakyRunner(Infinity);
    const first = build(dbPath, runner1);
    stores.push(first.store);
    const running = first.host.start({ id: 'r6', name: 'failure', source: plain, workspace: tmp() });
    await waitForStatus(first.store, 'r6', 'incident');
    await first.host.stopAll();
    await running;
    expect(first.store.getInstance('r6')?.status).toBe('incident'); // stop must not overwrite
    first.store.close();

    const runner2 = new FlakyRunner(0); // healthy now
    const second = build(dbPath, runner2);
    stores.push(second.store);
    const resumed = await second.host.resumeAll();
    await sleep(500);
    expect(runner2.calls).toBe(0); // held, not re-run
    expect(second.notifier.calls).toHaveLength(0); // not re-notified

    const [incident] = second.store.listOpenIncidents();
    await second.host.resolveIncident(incident.id, 'retry');
    await Promise.all(resumed.map((r) => r.completion));
    expect(second.store.getInstance('r6')?.status).toBe('completed');
  });
});
