import { createHash, randomBytes } from 'node:crypto';

/** Deterministic trace id per instance: spans emitted before and after a
 * daemon restart join the same trace (FR-24 must coexist with FR-9). */
export function traceIdFor(instanceId: string): string {
  return createHash('sha256').update(`flowfabric:trace:${instanceId}`).digest('hex').slice(0, 32);
}

/** Deterministic span id for the instance root span — the parent every
 * task span points at, even though the root span is emitted last. */
export function instanceSpanIdFor(instanceId: string): string {
  return createHash('sha256').update(`flowfabric:span:${instanceId}`).digest('hex').slice(0, 16);
}

/** Id generator with a one-shot override. The SDK never accepts explicit
 * span ids on startSpan; forcing the generator right before the (synchronous)
 * root-span startSpan is the only way to pin its ids. */
export class ForcedIdGenerator {
  private nextTraceId: string | undefined;
  private nextSpanId: string | undefined;

  force(traceId: string, spanId: string): void {
    this.nextTraceId = traceId;
    this.nextSpanId = spanId;
  }

  generateTraceId(): string {
    const id = this.nextTraceId ?? randomBytes(16).toString('hex');
    this.nextTraceId = undefined;
    return id;
  }

  generateSpanId(): string {
    const id = this.nextSpanId ?? randomBytes(8).toString('hex');
    this.nextSpanId = undefined;
    return id;
  }
}
