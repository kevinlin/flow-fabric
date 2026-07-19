import { describe, it, expect } from 'vitest';
import { nodeMarkers } from '../src/lib/node-status';
import type { EventDto } from '@flowfabric/shared';

const ev = (seq: number, type: string, elementId: string | null = null): EventDto =>
  ({ seq, type, elementId, detail: null, ts: seq });

describe('nodeMarkers', () => {
  it('marks the last event per node', () => {
    const markers = nodeMarkers([
      ev(1, 'activity.start', 'audit'),
      ev(2, 'activity.end', 'audit'),
      ev(3, 'activity.start', 'review'),
      ev(4, 'activity.wait', 'review'),
    ]);
    expect(markers).toEqual({ audit: 'node-done', review: 'node-waiting' });
  });
  it('maps a raised incident to failed and a timer to waiting', () => {
    const markers = nodeMarkers([
      ev(1, 'incident.raised', 'audit'),
      ev(2, 'activity.timer', 'wait'),
    ]);
    expect(markers).toEqual({ audit: 'node-failed', wait: 'node-waiting' });
  });
  it('ignores events without an element id', () => {
    expect(nodeMarkers([ev(1, 'engine.end', null)])).toEqual({});
  });
});
