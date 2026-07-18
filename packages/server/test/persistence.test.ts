import { mkdtempSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const source = readFileSync(new URL('./fixtures/basic.bpmn', import.meta.url), 'utf8');

describe('persistence', () => {
  let store: InstanceStore;
  afterEach(() => store?.close());

  it('records instance, events, and state snapshots for a completed run', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
    store = new InstanceStore(path.join(dir, 'spike.db'));
    const host = new EngineHost(store);

    await host.start({ id: 'i1', name: 'basic', source });

    const row = store.getInstance('i1');
    expect(row?.status).toBe('completed');
    expect(row?.engineState).toBeTruthy();
    const state = JSON.parse(row!.engineState!);
    expect(state.state).toBe('idle');

    const events = store.listEvents('i1');
    const types = events.map((e) => `${e.type}:${e.elementId ?? ''}`);
    expect(types).toContain('activity.start:start');
    expect(types).toContain('activity.end:inc');
    expect(types).toContain('engine.end:');
    expect(store.listNonTerminal()).toHaveLength(0);
  });
});
