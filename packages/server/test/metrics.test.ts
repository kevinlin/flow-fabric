import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('instance definition linkage', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('records definitionId/versionNo and exposes timestamps', () => {
    const dbPath = path.join(tmp(), 'ff.db');
    const store = new InstanceStore(dbPath);
    stores.push(store);
    store.createInstance('i1', 'n', '<xml/>', { definitionId: 'def-1', versionNo: 3 });
    const row = store.getInstance('i1')!;
    expect(row.definitionId).toBe('def-1');
    expect(row.versionNo).toBe(3);
    expect(row.createdAt).toBeGreaterThan(0);
    expect(row.updatedAt).toBeGreaterThanOrEqual(row.createdAt);
    // linkage is optional — M1/M2 callers unchanged
    store.createInstance('i2', 'n', '<xml/>');
    expect(store.getInstance('i2')!.definitionId).toBeNull();
    // migration guard: reopening the same DB must not throw
    const again = new InstanceStore(dbPath);
    stores.push(again);
    expect(again.getInstance('i1')!.versionNo).toBe(3);
  });
});
