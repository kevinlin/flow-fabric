import type { InstanceDto } from '@flowfabric/shared';

/** Derive the "waiting" display label the engine has no status column for
 * (design data model defers instances.status='waiting' — the UI computes it). */
export function deriveDisplayStatus(inst: InstanceDto, pendingUserTasks: number, armedTimers: number): string {
  if (inst.status === 'running') {
    if (pendingUserTasks > 0) return 'waiting (user task)';
    if (armedTimers > 0) return 'waiting (timer)';
  }
  return inst.status;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

export function fmtCost(usd: number | null): string {
  return usd === null || usd === undefined ? '—' : `$${usd.toFixed(4)}`;
}

export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}
