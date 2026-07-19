import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
import { buildApi } from '../src/api/server.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('static SPA serving', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('serves index.html at / and keeps /api working', async () => {
    const webRoot = tmp();
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Flow Fabric</title>');
    const store = new InstanceStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    let inbox!: Inbox;
    const host = new EngineHost(store, { onUserTaskWait: (i) => inbox.handleWait(i) });
    inbox = new Inbox(store, host, { notify: async () => {} });
    const app = buildApi({ store, host, inbox, webRoot });

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Flow Fabric');

    const health = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(health.json()).toEqual({ ok: true });
  });
});
