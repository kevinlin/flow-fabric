import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

// loop.bpmn: gateway loop around a 2s duration timer (rfp-daily shape).
const loop = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('scheduler state', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('lists an armed timer while waiting and clears it after firing', async () => {
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    const host = new EngineHost(store, {});
    const completion = host.start({ id: 'i1', name: 'loop', source: loop, workspace: tmp() });

    let armed: ReturnType<typeof host.scheduledTimers> = [];
    for (let i = 0; i < 50 && armed.length === 0; i++) {
      armed = host.scheduledTimers();
      if (armed.length === 0) await sleep(50);
    }
    expect(armed[0].instanceId).toBe('i1');
    expect(armed[0].expireAt).toBeGreaterThan(Date.now() - 1000);

    await completion; // loop runs to its end event
    expect(host.scheduledTimers()).toHaveLength(0);
  });
});
