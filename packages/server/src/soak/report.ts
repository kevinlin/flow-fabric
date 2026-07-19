export interface SoakInstanceInput {
  id: string;
  name: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  events: Array<{ type: string; elementId: string | null; ts: number }>;
  openIncidents: number;
  pendingUserTasks: number;
}

export type SoakVerdict =
  | 'finished'
  | 'waiting-timer'
  | 'waiting-user'
  | 'incident'
  | 'active'
  | 'SILENT-STALL';

export interface SoakInstanceReport {
  id: string;
  name: string;
  status: string;
  cycles: number;
  lastEventType: string | null;
  lastEventAgeMs: number | null;
  verdict: SoakVerdict;
}

const TERMINAL = new Set(['completed', 'terminated', 'aborted', 'error']);

/**
 * Soak health verdict (success criterion 1: zero silent stalls — every halt
 * is a modeled end event or a surfaced incident/wait). Heuristics, checked
 * in order:
 *  - terminal status → finished
 *  - open incident → surfaced (incident)
 *  - pending user task → surfaced (waiting-user)
 *  - last event is an armed timer younger than timerSlackMs (default 25 h,
 *    daily loop + slack) → waiting-timer
 *  - any event younger than activeThresholdMs (default 1 h) → active
 *  - otherwise → SILENT-STALL
 */
export function analyzeInstance(
  inst: SoakInstanceInput,
  now: number,
  opts: { timerSlackMs?: number; activeThresholdMs?: number } = {},
): SoakInstanceReport {
  const timerSlackMs = opts.timerSlackMs ?? 25 * 3_600_000;
  const activeThresholdMs = opts.activeThresholdMs ?? 3_600_000;
  const last = inst.events.at(-1);
  const base = {
    id: inst.id,
    name: inst.name,
    status: inst.status,
    cycles: inst.events.filter((e) => e.type === 'activity.timeout').length,
    lastEventType: last?.type ?? null,
    lastEventAgeMs: last ? now - last.ts : null,
  };
  const verdict = ((): SoakVerdict => {
    if (TERMINAL.has(inst.status)) return 'finished';
    if (inst.status === 'incident' || inst.openIncidents > 0) return 'incident';
    if (inst.pendingUserTasks > 0) return 'waiting-user';
    if (last?.type === 'activity.timer' && now - last.ts < timerSlackMs) return 'waiting-timer';
    if (last && now - last.ts < activeThresholdMs) return 'active';
    return 'SILENT-STALL';
  })();
  return { ...base, verdict };
}
