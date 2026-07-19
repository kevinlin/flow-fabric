import type { EventDto } from '@flowfabric/shared';

const TYPE_TO_MARKER: Record<string, string> = {
  'activity.start': 'node-running',
  'activity.end': 'node-done',
  'activity.wait': 'node-waiting',
  'activity.timer': 'node-waiting',
  'incident.raised': 'node-failed',
  'task.attempt-failed': 'node-failed',
};

/** Last relevant event per node id wins (events arrive in seq order). */
export function nodeMarkers(events: EventDto[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of events) {
    if (!e.elementId) continue;
    const marker = TYPE_TO_MARKER[e.type];
    if (marker) out[e.elementId] = marker;
  }
  return out;
}
