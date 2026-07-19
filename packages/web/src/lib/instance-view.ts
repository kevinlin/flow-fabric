import type { InstanceDto } from '@flowfabric/shared';

/** Status as the UI shows it: a badge class (reused across Instances, Timeline,
 * and Instance detail so one concept reads one way) plus a human label. The
 * engine has no status='waiting' column — the UI derives it from pending user
 * tasks / armed timers (design data model defers it). */
export function deriveStatusView(
  inst: InstanceDto,
  pendingUserTasks: number,
  armedTimers: number,
): { badgeClass: string; label: string } {
  if (inst.status === 'running') {
    if (pendingUserTasks > 0) return { badgeClass: 'waiting', label: 'waiting · user task' };
    if (armedTimers > 0) return { badgeClass: 'waiting', label: 'waiting · timer' };
  }
  return { badgeClass: inst.status, label: inst.status };
}

/** Plain-string label form, kept for callers that only need text. */
export function deriveDisplayStatus(inst: InstanceDto, pendingUserTasks: number, armedTimers: number): string {
  const { label } = deriveStatusView(inst, pendingUserTasks, armedTimers);
  // Preserve the historical parenthesised phrasing for the text-only contract.
  return label.replace('waiting · user task', 'waiting (user task)').replace('waiting · timer', 'waiting (timer)');
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
