import { describe, expect, it } from 'vitest';
import { ForcedIdGenerator, instanceSpanIdFor, traceIdFor } from '../src/telemetry/ids.js';

describe('telemetry ids', () => {
  it('derives stable, well-formed ids from the instance id', () => {
    expect(traceIdFor('inst-1')).toBe(traceIdFor('inst-1'));
    expect(traceIdFor('inst-1')).toMatch(/^[0-9a-f]{32}$/);
    expect(instanceSpanIdFor('inst-1')).toBe(instanceSpanIdFor('inst-1'));
    expect(instanceSpanIdFor('inst-1')).toMatch(/^[0-9a-f]{16}$/);
    expect(traceIdFor('inst-1')).not.toBe(traceIdFor('inst-2'));
    expect(instanceSpanIdFor('inst-1')).not.toBe(instanceSpanIdFor('inst-2'));
  });

  it('ForcedIdGenerator emits forced ids exactly once, then random', () => {
    const gen = new ForcedIdGenerator();
    gen.force('a'.repeat(32), 'b'.repeat(16));
    expect(gen.generateTraceId()).toBe('a'.repeat(32));
    expect(gen.generateSpanId()).toBe('b'.repeat(16));
    expect(gen.generateTraceId()).not.toBe('a'.repeat(32));
    expect(gen.generateTraceId()).toMatch(/^[0-9a-f]{32}$/);
    expect(gen.generateSpanId()).toMatch(/^[0-9a-f]{16}$/);
  });
});
