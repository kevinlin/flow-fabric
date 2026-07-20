import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DefinitionStore, DefinitionNotFoundError, DefinitionInUseError } from '../src/definitions/store.js';
import { createDaemon, type Daemon } from '../src/compose.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);
const INTERVIEW_PATH = new URL('../../../Input/bpmn/interview-process.bpmn', import.meta.url);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

describe('DefinitionStore', () => {
  const stores: Array<{ close(): void }> = [];
  afterEach(() => stores.forEach((s) => s.close()));

  function defStore() {
    const store = new DefinitionStore(path.join(tmp(), 'ff.db'));
    stores.push(store);
    return store;
  }

  it('uploads a definition as version 1 and retrieves it', () => {
    const defs = defStore();
    const { id, versionNo } = defs.upload('contracts', contracts);
    expect(versionNo).toBe(1);
    expect(defs.getDefinition(id)?.name).toBe('contracts');
    const v = defs.getVersion(id, 1)!;
    expect(v.xml).toBe(contracts);
    expect(v.deployable).toBe(false);
    expect(v.lintReport).toBeNull();
  });

  it('saveVersion appends immutable versions and getLatestVersion returns the newest', () => {
    const defs = defStore();
    const { id } = defs.upload('contracts', contracts);
    const report = { findings: [], errorCount: 0, deployable: true };
    const v2 = defs.saveVersion(id, contracts.replace('Audit tracker', 'Audit tracker v2'), report);
    expect(v2).toBe(2);
    expect(defs.getLatestVersion(id)?.versionNo).toBe(2);
    expect(defs.getLatestVersion(id)?.deployable).toBe(true);
    // version 1 untouched
    expect(defs.getVersion(id, 1)?.xml).toBe(contracts);
  });

  it('setLintReport fills report + deployable without touching xml', () => {
    const defs = defStore();
    const { id } = defs.upload('contracts', contracts);
    defs.setLintReport(id, 1, { findings: [], errorCount: 0, deployable: true });
    const v = defs.getVersion(id, 1)!;
    expect(v.deployable).toBe(true);
    expect(v.xml).toBe(contracts);
  });

  it('deletes a definition and all its versions', () => {
    const defs = defStore();
    const { id } = defs.upload('contracts', contracts);
    defs.saveVersion(id, contracts);
    expect(defs.listVersions(id)).toHaveLength(2);
    defs.delete(id);
    expect(defs.getDefinition(id)).toBeUndefined();
    expect(defs.listVersions(id)).toHaveLength(0);
    expect(defs.listDefinitions()).toHaveLength(0);
  });

  it('throws DefinitionNotFoundError when deleting a missing definition', () => {
    const defs = defStore();
    expect(() => defs.delete('nonexistent')).toThrow(DefinitionNotFoundError);
  });

  it('throws DefinitionInUseError when instances reference the definition', () => {
    const dir = tmp();
    const d = createDaemon({ dataDir: dir });
    daemons.push(d);
    const defs = d.definitions;
    const { id } = defs.upload('contracts', contracts);
    defs.setLintReport(id, 1, { findings: [], errorCount: 0, deployable: true });
    const completion = d.host.start({
      id: 'inst-1', name: 'test', source: contracts,
      workspace: dir, dryRun: true, definitionId: id, versionNo: 1,
    });
    completion.catch(() => {});
    expect(() => defs.delete(id)).toThrow(DefinitionInUseError);
    expect(defs.getDefinition(id)).toBeDefined();
  });

  it.skipIf(!existsSync(RFP_PATH))('uploads both real Input files (impl M3.1 verify)', () => {
    const defs = defStore();
    for (const url of [RFP_PATH, INTERVIEW_PATH]) {
      const xml = readFileSync(url, 'utf8');
      const { id } = defs.upload(path.basename(url.pathname, '.bpmn'), xml);
      expect(defs.getVersion(id, 1)?.xml).toBe(xml);
    }
    expect(defs.listDefinitions()).toHaveLength(2);
  });
});

describe('definitions API', () => {
  function build() {
    const d = createDaemon({ dataDir: tmp() });
    daemons.push(d);
    return d;
  }

  it('uploads, lists, and fetches versions over HTTP', async () => {
    const { app } = build();
    const created = await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'contracts', xml: contracts },
    });
    expect(created.statusCode).toBe(201);
    const { id, versionNo } = created.json();
    expect(versionNo).toBe(1);

    const list = await app.inject({ method: 'GET', url: '/api/definitions' });
    expect(list.json().definitions.map((d: any) => d.id)).toContain(id);

    const v = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/1` });
    expect(v.statusCode).toBe(200);
    expect(v.json().xml).toBe(contracts);

    const latest = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/latest` });
    expect(latest.json().versionNo).toBe(1);

    const missing = await app.inject({ method: 'GET', url: `/api/definitions/${id}/versions/9` });
    expect(missing.statusCode).toBe(404);
  });

  it('lints a version on demand and stores the report', async () => {
    const { app, definitions } = build();
    const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'messy', xml: messy },
    })).json();
    const res = await app.inject({ method: 'POST', url: `/api/definitions/${id}/versions/1/lint` });
    expect(res.statusCode).toBe(200);
    expect(res.json().deployable).toBe(false);
    expect(definitions.getVersion(id, 1)?.lintReport?.errorCount).toBeGreaterThan(0);
  });

  it('DELETE /api/definitions/:id removes an unused definition (204)', async () => {
    const { app, definitions } = build();
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'contracts', xml: contracts },
    })).json();
    const res = await app.inject({ method: 'DELETE', url: `/api/definitions/${id}` });
    expect(res.statusCode).toBe(204);
    expect(definitions.getDefinition(id)).toBeUndefined();
    const list = await app.inject({ method: 'GET', url: '/api/definitions' });
    expect(list.json().definitions).toHaveLength(0);
  });

  it('DELETE /api/definitions/:id returns 404 for unknown id', async () => {
    const { app } = build();
    const res = await app.inject({ method: 'DELETE', url: '/api/definitions/nonexistent' });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE /api/definitions/:id returns 409 when instances exist', async () => {
    const { app, definitions } = build();
    const { id } = (await app.inject({
      method: 'POST', url: '/api/definitions', payload: { name: 'contracts', xml: contracts },
    })).json();
    definitions.setLintReport(id, 1, { findings: [], errorCount: 0, deployable: true });
    const started = await app.inject({
      method: 'POST', url: '/api/instances',
      payload: { definitionId: id, version: 1, workspacePath: tmp(), dryRun: true },
    });
    expect(started.statusCode).toBe(201);
    const res = await app.inject({ method: 'DELETE', url: `/api/definitions/${id}` });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('linked instance');
  });
});
