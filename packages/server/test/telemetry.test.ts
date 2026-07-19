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

describe('instance root span + run metrics', () => {
  it('emits the root span with deterministic ids and event-log span events', async () => {
    const { telemetry, spans, metricByName } = makeTelemetry();
    telemetry.taskExecution({
      instanceId: 'inst-9', nodeId: 'Task_a', actor: 'code', attempt: 1,
      status: 'completed', startedAt: 100, endedAt: 200,
    });
    telemetry.instanceEnded({
      instanceId: 'inst-9',
      name: 'rfp-daily',
      status: 'terminated',
      // Non-zero start: the OTel SDK treats startTime:0 as falsy and
      // substitutes Date.now(); production passes row.createdAt (a real epoch).
      startedAt: 1_000,
      endedAt: 6_000,
      definitionId: 'def-1',
      versionNo: 3,
      dryRun: false,
      events: [
        { type: 'activity.start', elementId: 'Task_a', ts: 100 },
        { type: 'activity.end', elementId: 'Task_a', ts: 200 },
      ],
    });
    await telemetry.flush();

    const root = spans.getFinishedSpans().find((s) => s.name === 'rfp-daily')!;
    expect(root.spanContext().traceId).toBe(traceIdFor('inst-9'));
    expect(root.spanContext().spanId).toBe(instanceSpanIdFor('inst-9'));
    expect(root.attributes['ff.status']).toBe('terminated');
    expect(root.attributes['ff.definition_id']).toBe('def-1');
    expect(root.events.map((e) => e.name)).toEqual([
      'activity.start Task_a',
      'activity.end Task_a',
    ]);
    expect(hrToMs(root.startTime)).toBe(1_000);
    expect(hrToMs(root.endTime)).toBe(6_000);

    // the task span from before shares the trace and points at this root
    const task = spans.getFinishedSpans().find((s) => s.name === 'Task_a')!;
    expect(task.spanContext().traceId).toBe(root.spanContext().traceId);
    expect(task.parentSpanContext?.spanId).toBe(root.spanContext().spanId);

    const dur = metricByName('ff.run.duration')!;
    expect((dur as any).dataPoints[0].value.sum).toBe(5_000);
    expect((dur as any).dataPoints[0].attributes).toMatchObject({ status: 'terminated' });
    await telemetry.shutdown();
  });

  it('marks aborted/error instances as ERROR and counts incidents', async () => {
    const { telemetry, spans, metricByName } = makeTelemetry();
    telemetry.incidentRaised('Task_flaky');
    telemetry.instanceEnded({
      instanceId: 'inst-x', name: 'run', status: 'aborted',
      startedAt: 0, endedAt: 10, dryRun: true, events: [],
    });
    await telemetry.flush();
    expect(spans.getFinishedSpans()[0].status.code).toBe(SpanStatusCode.ERROR);
    const inc = metricByName('ff.incidents')!;
    expect((inc as any).dataPoints[0].value).toBe(1);
    expect((inc as any).dataPoints[0].attributes).toMatchObject({ node_id: 'Task_flaky' });
    await telemetry.shutdown();
  });
});
