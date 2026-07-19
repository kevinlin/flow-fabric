import { describe, expect, it } from 'vitest';
import { analyzeInstance, type SoakInstanceInput } from '../src/soak/report.js';

const HOUR = 3_600_000;
const NOW = 100 * HOUR;

function inst(over: Partial<SoakInstanceInput>): SoakInstanceInput {
  return {
    id: 'i1', name: 'rfp-daily', status: 'running',
    createdAt: 0, updatedAt: NOW,
    events: [], openIncidents: 0, pendingUserTasks: 0,
    ...over,
  };
}

describe('analyzeInstance', () => {
  it('terminal statuses are finished', () => {
    for (const status of ['completed', 'terminated', 'aborted', 'error']) {
      expect(analyzeInstance(inst({ status }), NOW).verdict).toBe('finished');
    }
  });

  it('open incidents are surfaced, not stalls', () => {
    expect(analyzeInstance(inst({ status: 'incident', openIncidents: 1 }), NOW).verdict).toBe('incident');
  });

  it('pending user tasks are surfaced waits', () => {
    expect(analyzeInstance(inst({ pendingUserTasks: 1 }), NOW).verdict).toBe('waiting-user');
  });

  it('a recently armed timer is a healthy wait; a stale one is a stall', () => {
    const armed = inst({ events: [{ type: 'activity.timer', elementId: 'T1', ts: NOW - 20 * HOUR }] });
    expect(analyzeInstance(armed, NOW).verdict).toBe('waiting-timer');
    const stale = inst({ events: [{ type: 'activity.timer', elementId: 'T1', ts: NOW - 30 * HOUR }] });
    expect(analyzeInstance(stale, NOW).verdict).toBe('SILENT-STALL');
  });

  it('recent non-timer activity is active; stale is a stall', () => {
    const busy = inst({ events: [{ type: 'activity.start', elementId: 'A', ts: NOW - HOUR / 2 }] });
    expect(analyzeInstance(busy, NOW).verdict).toBe('active');
    const dead = inst({ events: [{ type: 'activity.start', elementId: 'A', ts: NOW - 2 * HOUR }] });
    expect(analyzeInstance(dead, NOW).verdict).toBe('SILENT-STALL');
  });

  it('counts completed timer waits as cycles and reports last-event data', () => {
    const r = analyzeInstance(
      inst({
        events: [
          { type: 'activity.timer', elementId: 'T1', ts: 1 * HOUR },
          { type: 'activity.timeout', elementId: 'T1', ts: 25 * HOUR },
          { type: 'activity.timer', elementId: 'T1', ts: 26 * HOUR },
          { type: 'activity.timeout', elementId: 'T1', ts: 50 * HOUR },
          { type: 'activity.timer', elementId: 'T1', ts: NOW - HOUR },
        ],
      }),
      NOW,
    );
    expect(r.cycles).toBe(2);
    expect(r.lastEventType).toBe('activity.timer');
    expect(r.lastEventAgeMs).toBe(HOUR);
    expect(r.verdict).toBe('waiting-timer');
  });
});
