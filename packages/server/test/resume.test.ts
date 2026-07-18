import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/timer.bpmn', import.meta.url), 'utf8');
const TIMER_MS = 6000;
const SLACK_MS = 1500;

function tmpDb(): string {
  return path.join(mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')), 'spike.db');
}

async function waitForEvent(store: InstanceStore, id: string, type: string, elementId: string) {
  for (let i = 0; i < 100; i++) {
    if (store.listEvents(id).some((e) => e.type === type && e.elementId === elementId)) return;
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${type}:${elementId}`);
}

describe('durable resume', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('in-process: stop mid-timer, recover, resume; timer honors original schedule', async () => {
    const dbPath = tmpDb();
    const store1 = new InstanceStore(dbPath);
    stores.push(store1);
    const host1 = new EngineHost(store1);

    const startedAt = Date.now();
    const running = host1.start({ id: 'r1', name: 'timer', source });
    // bpmn-engine emits activity.timer (not activity.wait) when a timer catch event arms.
    await waitForEvent(store1, 'r1', 'activity.timer', 'wait');
    await sleep(3000); // let ~3s of the 6s timer elapse
    await host1.stopAll();
    await running; // resolves as 'stopped'
    expect(store1.getInstance('r1')?.status).toBe('stopped');
    store1.close();

    // "Restart": fresh store + host over the same DB file.
    const store2 = new InstanceStore(dbPath);
    stores.push(store2);
    const host2 = new EngineHost(store2);
    const resumeStart = Date.now();
    const resumed = host2.resumeAll();
    expect(resumed.map((r) => r.id)).toEqual(['r1']);
    await resumed[0].completion;

    const resumeElapsed = Date.now() - resumeStart;
    const remaining = TIMER_MS - (resumeStart - startedAt);
    expect(store2.getInstance('r1')?.status).toBe('completed');
    // Go/no-go assertion: fires at original schedule (~remaining), not re-armed to full 6s.
    expect(resumeElapsed).toBeLessThan(Math.max(remaining, 0) + SLACK_MS);
  });

  it('SIGKILL: crash mid-timer, resume in this process, instance completes on schedule', async () => {
    const dbPath = tmpDb();
    const script = new URL('../scripts/spike-child.ts', import.meta.url).pathname;
    const child = spawn(process.execPath, ['--import', 'tsx', script, dbPath, 'k1'], {
      cwd: new URL('..', import.meta.url).pathname,
      stdio: 'inherit',
    });
    const childStart = Date.now();

    const store = new InstanceStore(dbPath);
    stores.push(store);
    await waitForEvent(store, 'k1', 'activity.timer', 'wait');
    await sleep(3000);
    child.kill('SIGKILL');
    await sleep(500); // let the OS reap it

    // Crash leaves status 'running' — resumeAll must still pick it up.
    expect(store.getInstance('k1')?.status).toBe('running');

    const host = new EngineHost(store);
    const resumeStart = Date.now();
    const resumed = host.resumeAll();
    expect(resumed.map((r) => r.id)).toEqual(['k1']);
    await resumed[0].completion;

    const resumeElapsed = Date.now() - resumeStart;
    const remaining = TIMER_MS - (resumeStart - childStart);
    expect(store.getInstance('k1')?.status).toBe('completed');
    expect(resumeElapsed).toBeLessThan(Math.max(remaining, 0) + SLACK_MS);
  });
});
