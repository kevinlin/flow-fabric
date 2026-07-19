import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DashboardsPage } from '../src/pages/DashboardsPage';

afterEach(() => vi.restoreAllMocks());

describe('DashboardsPage', () => {
  it('renders success rate and run counts for the selected definition', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/definitions')
        return new Response(JSON.stringify({ definitions: [{ id: 'def-1', name: 'rfp', createdAt: 0 }] }),
          { headers: { 'content-type': 'application/json' } });
      return new Response(JSON.stringify({
        runs: { total: 4, completed: 2, terminated: 0, aborted: 1, error: 0, active: 1 },
        successRate: 0.6667, durationsMs: [1000, 2000],
        costPerRun: [{ instanceId: 'a', costUsd: 0.75 }],
        costPerTask: [{ nodeId: 'audit', runs: 2, totalCostUsd: 0.75, avgDurationMs: 1500 }],
        incidents: { total: 1, open: 1 },
      }), { headers: { 'content-type': 'application/json' } });
    }));
    render(<DashboardsPage />);
    await waitFor(() => expect(screen.getByText(/67%/)).toBeTruthy());
    expect(screen.getByText(/audit/)).toBeTruthy();
  });
});
