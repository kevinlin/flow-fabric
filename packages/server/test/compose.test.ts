import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect } from 'vitest';
import { createDaemon } from '../src/compose.js';
import type { Telemetry } from '../src/telemetry/telemetry.js';

const basic = readFileSync(new URL('./fixtures/basic.bpmn', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

async function until<T>(fn: () => T | undefined | false): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = fn();
    if (value) return value;
    await sleep(100);
  }
  throw new Error('condition not reached');
}

describe('composition root', () => {
  it('wires an inert daemon: dry run completes over HTTP with defaults only', async () => {
    const d = createDaemon({ dataDir: tmp() });
    const created = await d.app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { name: 'basic', source: basic, workspacePath: tmp(), dryRun: true },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json();
    await until(() => d.store.getInstance(id)?.status === 'completed');

    // full graph: definitions/grill routes are registered, not conditional
    const defs = await d.app.inject({ method: 'GET', url: '/api/definitions' });
    expect(defs.statusCode).toBe(200);
    await d.close();
  });

  it('close() stops a waiting engine and closes the stores', async () => {
    const d = createDaemon({ dataDir: tmp() });
    await d.app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: { name: 'contracts', source: contracts, workspacePath: tmp(), dryRun: true },
    });
    // default notifier is a no-op: reaching the user-task wait must not throw
    await until(() => d.inbox.listPending().length === 1);

    await d.close();
    expect(() => d.store.getInstance('any')).toThrow(/not open/);
    await d.close(); // idempotent: a test that closed mid-run may be swept again by afterEach
  });

  it('grill default is inert: send() fails fast instead of calling the SDK', async () => {
    const d = createDaemon({ dataDir: tmp() });
    const { id } = d.definitions.upload('basic', basic);
    const session = await d.grill.start(id);
    await expect(session.send('hello')).rejects.toThrow(/queryFn/);
    await d.close();
  });

  it('close() right after start() settles the run instead of leaking a live engine', async () => {
    const d = createDaemon({ dataDir: tmp() });
    const completion = d.host.start({
      id: 'race1', name: 'contracts', source: contracts, workspace: tmp(), dryRun: true,
    });
    await d.close();
    await expect(
      Promise.race([
        completion,
        sleep(3000).then(() => Promise.reject(new Error('completion never settled'))),
      ]),
    ).resolves.toBeUndefined();
  });

  it('close() shuts down telemetry only after engines stop', async () => {
    const order: string[] = [];
    const telemetry: Telemetry = {
      enabled: true,
      taskExecution: () => {},
      instanceEnded: () => {},
      incidentRaised: () => {},
      flush: async () => {},
      shutdown: async () => {
        order.push('telemetry');
      },
    };
    const d = createDaemon({ dataDir: tmp(), telemetry });
    const stopAll = d.host.stopAll.bind(d.host);
    d.host.stopAll = async () => {
      order.push('stopAll');
      return stopAll();
    };

    await d.close();
    expect(order).toEqual(['stopAll', 'telemetry']);
  });
});
