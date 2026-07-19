import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Counter,
  type Histogram,
  type Tracer,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from '@opentelemetry/sdk-metrics';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { ForcedIdGenerator, instanceSpanIdFor, traceIdFor } from './ids.js';

export type TaskActor = 'agent' | 'code' | 'user';
export type FinishedInstanceStatus = 'completed' | 'terminated' | 'aborted' | 'error';

export interface TaskExecutionTelemetry {
  instanceId: string;
  nodeId: string;
  actor: TaskActor;
  attempt: number;
  status: 'completed' | 'failed';
  startedAt: number;
  endedAt: number;
  error?: string;
  tokenUsage?: string;
  costUsd?: number;
}

export interface InstanceEndTelemetry {
  instanceId: string;
  name: string;
  status: FinishedInstanceStatus;
  startedAt: number;
  endedAt: number;
  definitionId?: string;
  versionNo?: number;
  dryRun: boolean;
  events: Array<{ type: string; elementId: string | null; ts: number }>;
}

export interface Telemetry {
  readonly enabled: boolean;
  taskExecution(t: TaskExecutionTelemetry): void;
  instanceEnded(t: InstanceEndTelemetry): void;
  incidentRaised(nodeId: string): void;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OtelTelemetryOptions {
  spanProcessors: SpanProcessor[];
  metricReaders: MetricReader[];
}

export class OtelTelemetry implements Telemetry {
  readonly enabled = true;
  private ids = new ForcedIdGenerator();
  private tracerProvider: BasicTracerProvider;
  private meterProvider: MeterProvider;
  private tracer: Tracer;
  private taskExecutions: Counter;
  private incidents: Counter;
  private taskDuration: Histogram;
  private runDuration: Histogram;
  private taskCost: Histogram;

  constructor(opts: OtelTelemetryOptions) {
    const resource = defaultResource().merge(
      resourceFromAttributes({ [ATTR_SERVICE_NAME]: 'flow-fabric' }),
    );
    this.tracerProvider = new BasicTracerProvider({
      resource,
      spanProcessors: opts.spanProcessors,
      idGenerator: this.ids,
    });
    this.meterProvider = new MeterProvider({ resource, readers: opts.metricReaders });
    this.tracer = this.tracerProvider.getTracer('flow-fabric');
    const meter = this.meterProvider.getMeter('flow-fabric');
    this.taskExecutions = meter.createCounter('ff.task.executions', {
      description: 'Task executions by actor and status',
    });
    this.incidents = meter.createCounter('ff.incidents', { description: 'Incidents raised' });
    this.taskDuration = meter.createHistogram('ff.task.duration', {
      unit: 'ms',
      description: 'Task execution wall-clock duration',
    });
    this.runDuration = meter.createHistogram('ff.run.duration', {
      unit: 'ms',
      description: 'Instance wall-clock duration (finished runs)',
    });
    this.taskCost = meter.createHistogram('ff.task.cost', {
      unit: 'USD',
      description: 'Per-task-execution cost',
    });
  }

  taskExecution(t: TaskExecutionTelemetry): void {
    const parent = trace.setSpanContext(ROOT_CONTEXT, {
      traceId: traceIdFor(t.instanceId),
      spanId: instanceSpanIdFor(t.instanceId),
      traceFlags: TraceFlags.SAMPLED,
    });
    const span = this.tracer.startSpan(
      t.nodeId,
      {
        startTime: t.startedAt,
        attributes: {
          'ff.instance_id': t.instanceId,
          'ff.node_id': t.nodeId,
          'ff.actor': t.actor,
          'ff.attempt': t.attempt,
          ...(t.costUsd !== undefined && { 'ff.cost_usd': t.costUsd }),
          ...(t.tokenUsage !== undefined && { 'ff.token_usage': t.tokenUsage }),
        },
      },
      parent,
    );
    if (t.status === 'failed') span.setStatus({ code: SpanStatusCode.ERROR, message: t.error });
    span.end(t.endedAt);
    this.taskExecutions.add(1, { actor: t.actor, status: t.status });
    this.taskDuration.record(t.endedAt - t.startedAt, { actor: t.actor, node_id: t.nodeId });
    if (t.costUsd !== undefined) this.taskCost.record(t.costUsd, { node_id: t.nodeId });
  }

  instanceEnded(t: InstanceEndTelemetry): void {
    // The root span owns the deterministic ids; force() + startSpan is synchronous.
    this.ids.force(traceIdFor(t.instanceId), instanceSpanIdFor(t.instanceId));
    const span = this.tracer.startSpan(t.name, {
      startTime: t.startedAt,
      attributes: {
        'ff.instance_id': t.instanceId,
        'ff.status': t.status,
        'ff.dry_run': t.dryRun,
        ...(t.definitionId !== undefined && { 'ff.definition_id': t.definitionId }),
        ...(t.versionNo !== undefined && { 'ff.version_no': t.versionNo }),
      },
    });
    for (const e of t.events) {
      span.addEvent(e.elementId ? `${e.type} ${e.elementId}` : e.type, undefined, e.ts);
    }
    if (t.status === 'aborted' || t.status === 'error') {
      span.setStatus({ code: SpanStatusCode.ERROR, message: t.status });
    }
    span.end(t.endedAt);
    this.runDuration.record(t.endedAt - t.startedAt, { status: t.status });
  }

  incidentRaised(nodeId: string): void {
    this.incidents.add(1, { node_id: nodeId });
  }

  async flush(): Promise<void> {
    await this.tracerProvider.forceFlush();
    await this.meterProvider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.tracerProvider.shutdown();
    await this.meterProvider.shutdown();
  }
}

export const NOOP_TELEMETRY: Telemetry = {
  enabled: false,
  taskExecution() {},
  instanceEnded() {},
  incidentRaised() {},
  async flush() {},
  async shutdown() {},
};

/** FR-24 gate: OTLP export only when OTEL_EXPORTER_OTLP_ENDPOINT is set
 * (design §10 — config-gated, off by default). The exporters read the
 * endpoint from the environment themselves. */
export function initTelemetry(env: NodeJS.ProcessEnv = process.env): Telemetry {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT) return NOOP_TELEMETRY;
  return new OtelTelemetry({
    spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],
    metricReaders: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: 15_000,
      }),
    ],
  });
}
