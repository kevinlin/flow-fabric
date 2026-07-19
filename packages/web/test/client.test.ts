import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from '../src/api/client';

afterEach(() => vi.restoreAllMocks());

describe('api client', () => {
  it('GETs instances and returns the array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ instances: [{ id: 'i1', status: 'running' }] }),
      { headers: { 'content-type': 'application/json' } },
    )));
    const rows = await api.listInstances();
    expect(rows[0].id).toBe('i1');
    expect(fetch).toHaveBeenCalledWith('/api/instances', expect.objectContaining({ method: 'GET' }));
  });

  it('POSTs a user-task submit with a JSON body', async () => {
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    await api.submitUserTask(7, { approved: true });
    expect(spy).toHaveBeenCalledWith('/api/user-tasks/7/submit', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ vars: { approved: true } }),
    }));
  });
});
