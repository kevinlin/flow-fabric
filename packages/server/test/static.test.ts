import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('static SPA serving', () => {
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close();
  });

  it('serves index.html at / and keeps /api working', async () => {
    const webRoot = tmp();
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Flow Fabric</title>');
    const d = createDaemon({ dataDir: tmp(), webRoot });
    daemons.push(d);
    const { app } = d;

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Flow Fabric');

    const health = await app.inject({ method: 'GET', url: '/api/healthz' });
    expect(health.json()).toEqual({ ok: true });
  });
});
