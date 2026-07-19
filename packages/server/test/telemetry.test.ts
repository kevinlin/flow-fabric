import { describe, expect, it } from 'vitest';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { SpanStatusCode } from '@opentelemetry/api';
import { ForcedIdGenerator, instanceSpanIdFor, traceIdFor } from '../src/telemetry/ids.js';
import { OtelTelemetry } from '../src/telemetry/telemetry.js';

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

const hrToMs = (t: [number, number]) => t[0] * 1000 + t[1] / 1e6;

function makeTelemetry() {
  const spans = new InMemorySpanExporter();
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = new OtelTelemetry({
    spanProcessors: [new SimpleSpanProcessor(spans)],
    metricReaders: [
      new PeriodicExportingMetricReader({ exporter: metrics, exportIntervalMillis: 3_600_000 }),
    ],
  });
  const metricByName = (name: string) =>
    metrics
      .getMetrics()
      .flatMap((rm) => rm.scopeMetrics.flatMap((sm) => sm.metrics))
      .find((m) => m.descriptor.name === name);
  return { telemetry, spans, metricByName };
}

describe('task-execution spans + metrics', () => {
  it('emits a span parented under the deterministic instance root context', async () => {
    const { telemetry, spans, metricByName } = makeTelemetry();
    telemetry.taskExecution({
      instanceId: 'inst-1',
      nodeId: 'Task_audit',
      actor: 'agent',
      attempt: 2,
      status: 'completed',
      startedAt: 1_000,
      endedAt: 4_000,
      tokenUsage: '{"input_tokens":10}',
      costUsd: 0.12,
    });
    await telemetry.flush();

    const span = spans.getFinishedSpans().find((s: ReadableSpan) => s.name === 'Task_audit')!;
    expect(span.spanContext().traceId).toBe(traceIdFor('inst-1'));
    expect(span.parentSpanContext?.spanId).toBe(instanceSpanIdFor('inst-1'));
    expect(span.attributes['ff.actor']).toBe('agent');
    expect(span.attributes['ff.attempt']).toBe(2);
    expect(span.attributes['ff.cost_usd']).toBe(0.12);
    expect(span.attributes['ff.token_usage']).toBe('{"input_tokens":10}');
    expect(hrToMs(span.startTime)).toBe(1_000);
    expect(hrToMs(span.endTime)).toBe(4_000);
    expect(span.status.code).not.toBe(SpanStatusCode.ERROR);

    const counter = metricByName('ff.task.executions')!;
    const dp = (counter as any).dataPoints[0];
    expect(dp.value).toBe(1);
    expect(dp.attributes).toMatchObject({ actor: 'agent', status: 'completed' });
    const dur = metricByName('ff.task.duration')!;
    expect((dur as any).dataPoints[0].value.sum).toBe(3_000);
    const cost = metricByName('ff.task.cost')!;
    expect((cost as any).dataPoints[0].value.sum).toBeCloseTo(0.12);
    await telemetry.shutdown();
  });

  it('marks failed executions as ERROR and skips absent cost', async () => {
    const { telemetry, spans, metricByName } = makeTelemetry();
    telemetry.taskExecution({
      instanceId: 'inst-1',
      nodeId: 'Task_flaky',
      actor: 'code',
      attempt: 1,
      status: 'failed',
      startedAt: 0,
      endedAt: 500,
      error: 'boom',
    });
    await telemetry.flush();
    const span = spans.getFinishedSpans()[0];
    expect(span.status).toMatchObject({ code: SpanStatusCode.ERROR, message: 'boom' });
    expect(span.attributes['ff.cost_usd']).toBeUndefined();
    expect(metricByName('ff.task.cost')).toBeUndefined();
    await telemetry.shutdown();
  });
});
