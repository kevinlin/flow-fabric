import { describe, it, expect } from 'vitest';
import { deriveDisplayStatus, fmtDuration, fmtCost } from '../src/lib/instance-view';
import type { InstanceDto } from '@flowfabric/shared';

const inst = (status: InstanceDto['status']): InstanceDto => ({
  id: 'i', name: 'n', status, workspace: '/w', dryRun: false,
  definitionId: null, versionNo: null, createdAt: 0, updatedAt: 0,
});

describe('deriveDisplayStatus', () => {
  it('shows "waiting" when running with a pending user task', () => {
    expect(deriveDisplayStatus(inst('running'), 1, 0)).toBe('waiting (user task)');
  });
  it('shows "waiting (timer)" when running with an armed timer only', () => {
    expect(deriveDisplayStatus(inst('running'), 0, 1)).toBe('waiting (timer)');
  });
  it('passes real statuses through', () => {
    expect(deriveDisplayStatus(inst('incident'), 0, 0)).toBe('incident');
    expect(deriveDisplayStatus(inst('running'), 0, 0)).toBe('running');
  });
});

describe('formatters', () => {
  it('formats durations and cost', () => {
    expect(fmtDuration(1500)).toBe('1.5s');
    expect(fmtDuration(65000)).toBe('1m 5s');
    expect(fmtCost(0.1234)).toBe('$0.1234');
    expect(fmtCost(null)).toBe('—');
  });
});
