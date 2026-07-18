import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');

describe('timer loop across restart', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('completes 3 iterations with a restart during the second wait', async () => {
    const dbPath = path.join(mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')), 'spike.db');
    const store1 = new InstanceStore(dbPath);
    stores.push(store1);
    const host1 = new EngineHost(store1);

    const running = host1.start({ id: 'l1', name: 'loop', source });
    // Wait for the SECOND entry into the timer (one full loop done).
    // bpmn-engine emits activity.timer (not activity.wait) when the timer arms.
    for (let i = 0; i < 100; i++) {
      const waits = store1.listEvents('l1').filter(
        (e) => e.type === 'activity.timer' && e.elementId === 'wait',
      );
      if (waits.length >= 2) break;
      await sleep(100);
    }
    await host1.stopAll();
    await running;
    store1.close();

    const store2 = new InstanceStore(dbPath);
    stores.push(store2);
    const host2 = new EngineHost(store2);
    const resumed = await host2.resumeAll();
    await Promise.all(resumed.map((r) => r.completion));

    expect(store2.getInstance('l1')?.status).toBe('completed');
    const workEnds = store2
      .listEvents('l1')
      .filter((e) => e.type === 'activity.end' && e.elementId === 'work');
    expect(workEnds).toHaveLength(3);
  });
});
