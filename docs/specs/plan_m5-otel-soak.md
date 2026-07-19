# M5 OTel + Soak Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** FR-24 OpenTelemetry export (trace per instance, span per task execution, counters + histograms, OTLP config-gated, off by default) plus the G1 acceptance run: first real rfp-daily execution and a 7-day unattended soak under launchd, per impl spec M5.1–M5.4.

**Architecture:** A new `packages/server/src/telemetry/` module emits spans and metrics **post-hoc** — at record time, with explicit start/end timestamps — instead of holding live spans open across awaits. The `InstanceStore` is the single wiring seam (design §3 assigns "OTel emission" to the events module, which in this codebase is the store): `finishTaskExecution` → task span, terminal `setStatus` → instance root span with span events replayed from the event log, `createIncident` → incident counter. Tasks 7–12 are the operational half: Jaeger gate, launchd unit, soak-report script, supervised real run, 7-day soak, close-out.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), vitest 3, `@opentelemetry/api` ^1.9, `@opentelemetry/sdk-trace-base` + `@opentelemetry/sdk-metrics` + `@opentelemetry/resources` ^2.9, OTLP HTTP exporters ^0.220, `@opentelemetry/semantic-conventions` ^1.43. Jaeger v2 (docker) for the manual gate. launchd for the soak daemon.

## Design Decisions

- **Post-hoc span emission, deterministic ids.** A live span object cannot survive a daemon restart, but SQLite rows + deterministic ids can. Trace id = `sha256("flowfabric:trace:" + instanceId)` (32 hex), instance root span id = `sha256("flowfabric:span:" + instanceId)` (16 hex). Task spans emitted before and after a restart therefore join the same trace, and the root span — emitted once, when the instance reaches a terminal status — carries `startTime = createdAt` so a 7-day run renders as one 7-day trace. This is what makes FR-24 compatible with FR-9 durability.
- **The store is the telemetry seam.** Design §3 puts "OTel emission" in the `events` module; in this codebase that role is `InstanceStore` (single write path + SSE fan-out). Wiring telemetry into three store methods covers every producer for free: `finishTaskExecution` is hit by agent/code tasks (dispatch) *and* user tasks (inbox `submit`), terminal `setStatus` is hit by `run()`/`abort()`, `createIncident` by the failure ladder. Zero changes to EngineHost, dispatch, failure, or inbox.
- **`ForcedIdGenerator` for the root span only.** The SDK does not accept explicit span ids on `startSpan`. Task spans don't need one — they parent via a synthetic `SpanContext` (`trace.setSpanContext(ROOT_CONTEXT, {traceId, spanId, traceFlags})`). The root span must *own* the deterministic ids, so the provider gets a custom id generator with a one-shot `force(traceId, spanId)` called synchronously right before `startSpan`. No async between force and start → no race.
- **Gate = standard `OTEL_EXPORTER_OTLP_ENDPOINT`.** No `FF_*` variable: the OTLP HTTP exporters read this env var natively (and append `/v1/traces` / `/v1/metrics`). Unset → `NOOP_TELEMETRY`, zero OTel objects constructed (design §10 "config-gated; off by default"). No global registration (`trace.setGlobalTracerProvider` is never called) — everything flows through the injected provider, so tests stay isolated and no auto-instrumentation appears.
- **Graceful shutdown is for telemetry flush, not durability.** M1 proved SIGKILL safety; the new SIGTERM/SIGINT handler exists to flush pending OTLP batches and free the port under launchd. The store is *not* explicitly closed in the handler — an in-flight engine write racing a closed DB was exactly the M4 unhandled-rejection finding; process exit closes it safely (WAL).
- **Known gap, accepted:** `run()` appends the final `engine.end`/`engine.stop` event *after* `setStatus`, so the root span's event list misses that one event. The span's own end + status carry the same information.
- **Soak gate is checkable by code.** `scripts/soak-report.ts` computes daily-cycle count (`activity.timeout` events) and a per-instance verdict including `SILENT-STALL` (running, no surfaced wait/incident, stale events), so M5.3's "zero silent stalls" is a script exit code, not vibes.
- **launchd over pm2.** Native macOS, no extra runtime dependency; `KeepAlive` restarts on crash, which doubles as a production-shape resume test.

## Global Constraints

- Node ≥ 22, pnpm workspaces. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext` — **import local modules with the `.js` extension** in server source.
- New server dependencies (exact floors): `@opentelemetry/api@^1.9.0`, `@opentelemetry/sdk-trace-base@^2.9.0`, `@opentelemetry/sdk-metrics@^2.9.0`, `@opentelemetry/resources@^2.9.0`, `@opentelemetry/semantic-conventions@^1.43.0`, `@opentelemetry/exporter-trace-otlp-http@^0.220.0`, `@opentelemetry/exporter-metrics-otlp-http@^0.220.0`. Nothing else; no `@opentelemetry/sdk-node`, no auto-instrumentations.
- Telemetry enabled **iff** `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Default off.
- Attribute/metric namespace: `ff.` prefix throughout (`ff.instance_id`, `ff.task.duration`, …). Resource `service.name` = `flow-fabric`.
- Test databases in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))`, never in the repo.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Real workspaces (`Input/`, RFP workspace) are git-ignored — nothing from the soak lands in the repo except findings text.

## File Structure

| Path | Change |
|---|---|
| `packages/server/src/telemetry/ids.ts` | Create — deterministic trace/span id derivation + `ForcedIdGenerator` |
| `packages/server/src/telemetry/telemetry.ts` | Create — `Telemetry` interface, `OtelTelemetry`, `NOOP_TELEMETRY`, `initTelemetry` |
| `packages/server/src/engine-host/store.ts` | Modify — optional `telemetry` in constructor; emit from `finishTaskExecution`, `setStatus`, `createIncident` |
| `packages/server/src/daemon.ts` | Modify — `initTelemetry()`, pass to store, SIGTERM/SIGINT handler |
| `packages/server/src/index.ts` | Modify — export telemetry API |
| `packages/server/src/soak/report.ts` | Create — pure `analyzeInstance` soak analysis |
| `packages/server/scripts/soak-report.ts` | Create — CLI over the live DB (tsx, like the probes) |
| `packages/server/test/telemetry.test.ts` | Create — ids, spans, metrics, init gate |
| `packages/server/test/telemetry-store.test.ts` | Create — store seams with a recording fake |
| `packages/server/test/soak-report.test.ts` | Create — verdict/cycle unit tests |
| `ops/run-daemon.sh` | Create — launchd entrypoint |
| `ops/launchd/dev.flowfabric.daemon.plist` | Create — launchd unit template |
| `docs/ops/soak-runbook.md` | Create — install, daily check, soak log, teardown |
| `.env.example` | Modify — document `OTEL_EXPORTER_OTLP_ENDPOINT` |

---

### Task 1: OTel dependencies + deterministic ids

**Files:**
- Modify: `packages/server/package.json` (via pnpm add)
- Create: `packages/server/src/telemetry/ids.ts`
- Test: `packages/server/test/telemetry.test.ts`

**Interfaces:**
- Consumes: nothing (pure, `node:crypto` only)
- Produces: `traceIdFor(instanceId: string): string` (32 lowercase hex), `instanceSpanIdFor(instanceId: string): string` (16 lowercase hex), `class ForcedIdGenerator { force(traceId: string, spanId: string): void; generateTraceId(): string; generateSpanId(): string }`

- [ ] **Step 1: Install dependencies**

```bash
pnpm --filter @flowfabric/server add @opentelemetry/api@^1.9.0 @opentelemetry/sdk-trace-base@^2.9.0 @opentelemetry/sdk-metrics@^2.9.0 @opentelemetry/resources@^2.9.0 @opentelemetry/semantic-conventions@^1.43.0 @opentelemetry/exporter-trace-otlp-http@^0.220.0 @opentelemetry/exporter-metrics-otlp-http@^0.220.0
```

- [ ] **Step 2: Write the failing test**

Create `packages/server/test/telemetry.test.ts`:

```typescript
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
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: FAIL — cannot find `../src/telemetry/ids.js`

- [ ] **Step 4: Implement `ids.ts`**

Create `packages/server/src/telemetry/ids.ts`:

```typescript
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: PASS (2 tests)

- [ ] **Step 6: Commit**

```bash
git add packages/server/package.json pnpm-lock.yaml packages/server/src/telemetry/ids.ts packages/server/test/telemetry.test.ts
git commit -m "feat: telemetry ids — deterministic per-instance trace/span ids"
```

---

### Task 2: Task-execution spans + task metrics

**Files:**
- Create: `packages/server/src/telemetry/telemetry.ts`
- Test: `packages/server/test/telemetry.test.ts` (extend)

**Interfaces:**
- Consumes: `traceIdFor`, `instanceSpanIdFor`, `ForcedIdGenerator` from Task 1
- Produces:

```typescript
export type TaskActor = 'agent' | 'code' | 'user';

export interface TaskExecutionTelemetry {
  instanceId: string;
  nodeId: string;
  actor: TaskActor;
  attempt: number;
  status: 'completed' | 'failed';
  startedAt: number; // epoch ms
  endedAt: number;   // epoch ms
  error?: string;
  tokenUsage?: string; // raw JSON string, as stored
  costUsd?: number;
}

export interface Telemetry {
  readonly enabled: boolean;
  taskExecution(t: TaskExecutionTelemetry): void;
  instanceEnded(t: InstanceEndTelemetry): void; // Task 3
  incidentRaised(nodeId: string): void;          // Task 3
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface OtelTelemetryOptions {
  spanProcessors: SpanProcessor[];
  metricReaders: MetricReader[];
}
export class OtelTelemetry implements Telemetry { constructor(opts: OtelTelemetryOptions) }
```

(For this task, stub `instanceEnded` as an empty method and `incidentRaised` as an empty method — Task 3 fills them. The interface is declared complete now so later tasks compile against it.)

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/telemetry.test.ts`:

```typescript
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { SpanStatusCode } from '@opentelemetry/api';
import { OtelTelemetry } from '../src/telemetry/telemetry.js';

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
```

Also add `traceIdFor`/`instanceSpanIdFor` to the existing import from `../src/telemetry/ids.js` if the test file's import list needs it (it already imports them from Task 1).

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: FAIL — cannot find `../src/telemetry/telemetry.js`

- [ ] **Step 3: Implement `telemetry.ts`**

Create `packages/server/src/telemetry/telemetry.ts`:

```typescript
import {
  ROOT_CONTEXT,
  SpanStatusCode,
  TraceFlags,
  trace,
  type Counter,
  type Histogram,
  type Tracer,
} from '@opentelemetry/api';
import { BasicTracerProvider, type SpanProcessor } from '@opentelemetry/sdk-trace-base';
import { MeterProvider, type MetricReader } from '@opentelemetry/sdk-metrics';
import { defaultResource, resourceFromAttributes } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME } from '@opentelemetry/semantic-conventions';
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

  instanceEnded(_t: InstanceEndTelemetry): void {
    // Task 3
  }

  incidentRaised(_nodeId: string): void {
    // Task 3
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
```

API-drift note: if `tsc` rejects `new SimpleSpanProcessor(exporter)` (test file) or `BasicTracerProvider`, the installed sdk-trace has crossed the 3.x rename — switch to `new SimpleSpanProcessor({ exporter })` and `TracerProvider`. With the `^2.9.0` floor pinned above this should not happen.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/telemetry/telemetry.ts packages/server/test/telemetry.test.ts
git commit -m "feat: task-execution spans + task metrics (FR-24)"
```

---

### Task 3: Instance root span, span events, run metrics, incident counter

**Files:**
- Modify: `packages/server/src/telemetry/telemetry.ts` (fill the two stubs)
- Test: `packages/server/test/telemetry.test.ts` (extend)

**Interfaces:**
- Consumes: `OtelTelemetry`, `InstanceEndTelemetry` from Task 2; `ForcedIdGenerator.force` from Task 1
- Produces: working `instanceEnded(t: InstanceEndTelemetry): void` and `incidentRaised(nodeId: string): void`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/telemetry.test.ts`:

```typescript
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
      startedAt: 0,
      endedAt: 5_000,
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
    expect(hrToMs(root.startTime)).toBe(0);
    expect(hrToMs(root.endTime)).toBe(5_000);

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: FAIL — root span not found / incident counter missing (stubs are empty)

- [ ] **Step 3: Implement the two methods**

Replace the two stubs in `packages/server/src/telemetry/telemetry.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/telemetry/telemetry.ts packages/server/test/telemetry.test.ts
git commit -m "feat: instance root span with event-log span events + run metrics"
```

---

### Task 4: `NOOP_TELEMETRY` + config-gated `initTelemetry`

**Files:**
- Modify: `packages/server/src/telemetry/telemetry.ts`
- Test: `packages/server/test/telemetry.test.ts` (extend)

**Interfaces:**
- Consumes: `OtelTelemetry` from Tasks 2–3
- Produces: `NOOP_TELEMETRY: Telemetry` (enabled `false`, all methods no-ops), `initTelemetry(env?: NodeJS.ProcessEnv): Telemetry`

- [ ] **Step 1: Write the failing test**

Append to `packages/server/test/telemetry.test.ts`:

```typescript
import { NOOP_TELEMETRY, initTelemetry } from '../src/telemetry/telemetry.js';

describe('initTelemetry gate', () => {
  it('returns the no-op when OTEL_EXPORTER_OTLP_ENDPOINT is unset', () => {
    const t = initTelemetry({});
    expect(t.enabled).toBe(false);
    expect(t).toBe(NOOP_TELEMETRY);
    // no-op methods are safe to call
    t.taskExecution({
      instanceId: 'i', nodeId: 'n', actor: 'agent', attempt: 1,
      status: 'completed', startedAt: 0, endedAt: 1,
    });
    t.incidentRaised('n');
  });

  it('returns a live OtelTelemetry when the endpoint is set', async () => {
    const t = initTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://127.0.0.1:4318' });
    expect(t.enabled).toBe(true);
    // nothing was recorded, so shutdown flushes empty buffers (no network hit
    // for traces; the metric reader's final empty collect may log a benign
    // export warning to stderr — expected, nothing is listening on 4318).
    await t.shutdown();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: FAIL — `initTelemetry` / `NOOP_TELEMETRY` not exported

- [ ] **Step 3: Implement**

Append to `packages/server/src/telemetry/telemetry.ts` (add the two exporter imports at the top of the file):

```typescript
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base'; // merge into existing import
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'; // merge into existing import
```

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test telemetry`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/telemetry/telemetry.ts packages/server/test/telemetry.test.ts
git commit -m "feat: config-gated OTLP telemetry init, off by default (FR-24)"
```

---

### Task 5: Emit telemetry from the `InstanceStore` seams

**Files:**
- Modify: `packages/server/src/engine-host/store.ts`
- Test: `packages/server/test/telemetry-store.test.ts` (create)

**Interfaces:**
- Consumes: `Telemetry`, `TaskExecutionTelemetry`, `InstanceEndTelemetry` from Task 2 (type-only import — telemetry.ts imports nothing from store.ts, so no cycle)
- Produces: `new InstanceStore(dbPath: string, opts?: { telemetry?: Telemetry })` — all existing single-arg call sites keep compiling

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/telemetry-store.test.ts`:

```typescript
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import type {
  InstanceEndTelemetry,
  TaskExecutionTelemetry,
  Telemetry,
} from '../src/telemetry/telemetry.js';

function fakeTelemetry() {
  const calls = {
    tasks: [] as TaskExecutionTelemetry[],
    instances: [] as InstanceEndTelemetry[],
    incidents: [] as string[],
  };
  const telemetry: Telemetry = {
    enabled: true,
    taskExecution: (t) => void calls.tasks.push(t),
    instanceEnded: (t) => void calls.instances.push(t),
    incidentRaised: (nodeId) => void calls.incidents.push(nodeId),
    flush: async () => {},
    shutdown: async () => {},
  };
  return { telemetry, calls };
}

describe('InstanceStore telemetry seams', () => {
  let dir: string;
  let store: InstanceStore;
  let calls: ReturnType<typeof fakeTelemetry>['calls'];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
    const fake = fakeTelemetry();
    calls = fake.calls;
    store = new InstanceStore(path.join(dir, 'db.sqlite'), { telemetry: fake.telemetry });
    store.createInstance('inst-1', 'run', '<xml/>', { definitionId: 'def-1', versionNo: 2 });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finishTaskExecution emits the full execution record', () => {
    const id = store.startTaskExecution('inst-1', 'Task_a', 'agent', 2, { deadline: 'x' });
    store.finishTaskExecution(id, {
      status: 'completed',
      output: { ok: true },
      tokenUsage: { input_tokens: 5 },
      costUsd: 0.07,
    });
    expect(calls.tasks).toHaveLength(1);
    expect(calls.tasks[0]).toMatchObject({
      instanceId: 'inst-1',
      nodeId: 'Task_a',
      actor: 'agent',
      attempt: 2,
      status: 'completed',
      costUsd: 0.07,
    });
    expect(calls.tasks[0].endedAt).toBeGreaterThanOrEqual(calls.tasks[0].startedAt);
  });

  it('finishTaskExecution carries failure errors', () => {
    const id = store.startTaskExecution('inst-1', 'Task_a', 'code', 1, {});
    store.finishTaskExecution(id, { status: 'failed', error: 'boom' });
    expect(calls.tasks[0]).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('terminal setStatus emits instanceEnded once, with the event log', () => {
    store.appendEvent('inst-1', 'activity.start', 'Task_a');
    store.setStatus('inst-1', 'terminated');
    store.setStatus('inst-1', 'aborted'); // double terminal write → no second span
    expect(calls.instances).toHaveLength(1);
    expect(calls.instances[0]).toMatchObject({
      instanceId: 'inst-1',
      name: 'run',
      status: 'terminated',
      definitionId: 'def-1',
      versionNo: 2,
      dryRun: false,
    });
    expect(calls.instances[0].events).toEqual([
      expect.objectContaining({ type: 'activity.start', elementId: 'Task_a' }),
    ]);
  });

  it('non-terminal setStatus emits nothing', () => {
    store.setStatus('inst-1', 'stopped');
    store.setStatus('inst-1', 'running');
    expect(calls.instances).toHaveLength(0);
  });

  it('createIncident emits the incident counter', () => {
    store.createIncident('inst-1', 'Task_flaky', 'boom');
    expect(calls.incidents).toEqual(['Task_flaky']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test telemetry-store`
Expected: FAIL — `InstanceStore` constructor takes 1 argument / no telemetry calls recorded

- [ ] **Step 3: Wire the store**

In `packages/server/src/engine-host/store.ts`:

Add the type import at the top:

```typescript
import type { Telemetry } from '../telemetry/telemetry.js';
```

Add a module-level constant near the status type:

```typescript
const TERMINAL_STATUSES = new Set<InstanceStatus>(['completed', 'terminated', 'aborted', 'error']);
```

Change the constructor signature (field + assignment; everything else in the constructor unchanged):

```typescript
  private db: Database.Database;
  private emitter = new EventEmitter();
  private telemetry: Telemetry | undefined;

  constructor(dbPath: string, opts: { telemetry?: Telemetry } = {}) {
    this.telemetry = opts.telemetry;
    this.db = new Database(dbPath);
    // ... existing body unchanged
```

Replace `setStatus` with:

```typescript
  setStatus(id: string, status: InstanceStatus): void {
    const prior = this.telemetry ? this.getInstance(id)?.status : undefined;
    this.db
      .prepare(`UPDATE instances SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, Date.now(), id);
    if (!this.telemetry || !TERMINAL_STATUSES.has(status)) return;
    if (prior === undefined || TERMINAL_STATUSES.has(prior)) return; // unknown row or already terminal
    const row = this.getInstance(id)!;
    this.telemetry.instanceEnded({
      instanceId: id,
      name: row.name,
      status: status as 'completed' | 'terminated' | 'aborted' | 'error',
      startedAt: row.createdAt,
      endedAt: row.updatedAt,
      definitionId: row.definitionId ?? undefined,
      versionNo: row.versionNo ?? undefined,
      dryRun: row.dryRun,
      events: this.listEvents(id).map((e) => ({ type: e.type, elementId: e.elementId, ts: e.ts })),
    });
  }
```

At the end of `finishTaskExecution` (after the existing `.run(...)` call):

```typescript
    if (!this.telemetry) return;
    const row = this.getTaskExecution(id);
    if (!row) return;
    this.telemetry.taskExecution({
      instanceId: row.instanceId,
      nodeId: row.nodeId,
      actor: row.actor,
      attempt: row.attempt,
      status: result.status,
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? Date.now(),
      error: row.error ?? undefined,
      tokenUsage: row.tokenUsage ?? undefined,
      costUsd: row.costUsd ?? undefined,
    });
```

In `createIncident`, before the `return`:

```typescript
    this.telemetry?.incidentRaised(nodeId);
```

(Note: user tasks flow through `finishTaskExecution` too — `Inbox.submit` finishes the pending execution row — so human spans come for free.)

- [ ] **Step 4: Run the new test, then the full server suite**

Run: `pnpm --filter @flowfabric/server test telemetry-store`
Expected: PASS (5 tests)

Run: `pnpm --filter @flowfabric/server test`
Expected: all green — no existing test constructs `InstanceStore` with a second argument, and telemetry-less stores skip every new branch.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/engine-host/store.ts packages/server/test/telemetry-store.test.ts
git commit -m "feat: emit telemetry from InstanceStore seams (task spans, instance span, incidents)"
```

---

### Task 6: Daemon wiring, graceful shutdown, exports, `.env.example`

**Files:**
- Modify: `packages/server/src/daemon.ts`
- Modify: `packages/server/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `initTelemetry` from Task 4, store opts from Task 5, existing `EngineHost.stopAll()`
- Produces: daemon process that flushes telemetry on SIGTERM/SIGINT; `@flowfabric/server` exports `initTelemetry`, `NOOP_TELEMETRY`, `OtelTelemetry`, `Telemetry` + telemetry types, `traceIdFor`, `instanceSpanIdFor`

No unit test — `daemon.ts` is the untested entrypoint by convention; behavior is verified live in Task 7. Build must stay green.

- [ ] **Step 1: Wire the daemon**

In `packages/server/src/daemon.ts`, add the import:

```typescript
import { initTelemetry } from './telemetry/telemetry.js';
```

Replace the `const store = new InstanceStore(dbPath);` line with:

```typescript
const telemetry = initTelemetry();
const store = new InstanceStore(dbPath, { telemetry });
```

Append after the final `console.log`:

```typescript
console.log(`[flow-fabric] OTel export ${telemetry.enabled ? 'enabled' : 'disabled'}`);

// Graceful shutdown (launchd sends SIGTERM): flush telemetry and free the
// port. Durability does NOT depend on this — every transition is already
// snapshotted (M1: SIGKILL-safe) and resumeAll() recovers on next boot.
// The store is not closed explicitly: an in-flight engine write racing a
// closed DB was the M4 unhandled-rejection finding; process exit is safe.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void (async () => {
      console.log(`[flow-fabric] ${sig} — stopping engines, flushing telemetry`);
      await host.stopAll();
      await app.close();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
```

- [ ] **Step 2: Export the telemetry API**

Append to `packages/server/src/index.ts`:

```typescript
export { initTelemetry, NOOP_TELEMETRY, OtelTelemetry } from './telemetry/telemetry.js';
export type {
  Telemetry,
  TaskExecutionTelemetry,
  InstanceEndTelemetry,
  OtelTelemetryOptions,
} from './telemetry/telemetry.js';
export { traceIdFor, instanceSpanIdFor } from './telemetry/ids.js';
```

- [ ] **Step 3: Document the gate in `.env.example`**

Append to `.env.example`:

```bash
# OpenTelemetry export (FR-24). Unset = telemetry off (default).
# Point at any OTLP/HTTP collector, e.g. Jaeger v2: docker run --rm -d \
#   --name ff-jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2
# OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
```

- [ ] **Step 4: Verify build + full test suite**

Run: `pnpm build && pnpm test`
Expected: all packages green (shared, server, web).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/daemon.ts packages/server/src/index.ts .env.example
git commit -m "feat: wire telemetry into the daemon with graceful SIGTERM flush"
```

---

### Task 7: M5.1 manual gate — spans visible in Jaeger for a dry run

**Files:**
- Modify: `docs/specs/plan_m5-otel-soak.md` (record findings in the Changelog)

**Interfaces:**
- Consumes: everything from Tasks 1–6, built (`pnpm build`)
- Produces: the M5.1 verification gate record (impl spec: "spans visible in a local collector (e.g. Jaeger) for a dry run")

Manual, from the repo root. Requires Docker.

- [ ] **Step 1: Start Jaeger v2 (OTLP/HTTP on 4318, UI on 16686)**

```bash
docker run --rm -d --name ff-jaeger -p 16686:16686 -p 4318:4318 jaegertracing/jaeger:2
```

- [ ] **Step 2: Start the daemon with telemetry enabled against a scratch data dir**

```bash
pnpm build
mkdir -p /tmp/ff-otel-ws
FF_DATA_DIR=$(mktemp -d) OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  pnpm --filter @flowfabric/server dev
```

Expected boot lines: `daemon on http://127.0.0.1:4400` and `OTel export enabled`.

- [ ] **Step 3: Upload the deployable fixture and start a dry run**

In a second terminal:

```bash
DEF=$(curl -s -X POST http://127.0.0.1:4400/api/definitions -H 'content-type: application/json' \
  -d "$(jq -n --arg name daily-loop --rawfile xml packages/server/test/fixtures/daily-loop-refined.bpmn '{name:$name, xml:$xml}')" | jq -r .id)
curl -s -X POST http://127.0.0.1:4400/api/instances -H 'content-type: application/json' \
  -d "{\"definitionId\":\"$DEF\",\"workspacePath\":\"/tmp/ff-otel-ws\",\"dryRun\":true}"
```

Open http://127.0.0.1:4400/#/inbox and submit the pending user task(s) until the instance reaches a terminal state (Instances page shows `terminated`/`completed`).

- [ ] **Step 4: Verify in Jaeger**

Open http://localhost:16686, service `flow-fabric`. Confirm all of:

1. Exactly one trace for the run; the root span is named after the instance and spans the full run duration.
2. One child span per task execution (all three actors — the user task appears too), each carrying `ff.actor`, `ff.attempt`, `ff.instance_id` attributes.
3. The root span's log/event list shows the `activity.*` transitions.
4. Metrics did not error: daemon stderr shows no repeated OTLP export failures.

- [ ] **Step 5: Verify the off-by-default gate**

Restart the daemon *without* `OTEL_EXPORTER_OTLP_ENDPOINT`; boot line must read `OTel export disabled`, and a second dry run must produce no new Jaeger traces.

- [ ] **Step 6: Verify graceful shutdown**

Ctrl-C (SIGINT) the daemon: expect the `stopping engines, flushing telemetry` line and clean exit. Then tear down: `docker stop ff-jaeger`.

- [ ] **Step 7: Record findings + commit**

Append a dated entry to this plan's Changelog: Jaeger version used, screenshot-level description of the trace shape, any API drift encountered.

```bash
git add docs/specs/plan_m5-otel-soak.md
git commit -m "docs: record M5.1 OTel gate findings"
```

---

### Task 8: Soak report — cycle count + silent-stall detection

**Files:**
- Create: `packages/server/src/soak/report.ts`
- Create: `packages/server/scripts/soak-report.ts`
- Test: `packages/server/test/soak-report.test.ts`

**Interfaces:**
- Consumes: `InstanceStore` read methods (`listInstances`, `listEvents`, `listOpenIncidents`, `listPendingUserTasks`) — CLI only; the analysis is pure
- Produces:

```typescript
export interface SoakInstanceInput {
  id: string; name: string; status: string;
  createdAt: number; updatedAt: number;
  events: Array<{ type: string; elementId: string | null; ts: number }>;
  openIncidents: number;
  pendingUserTasks: number;
}
export type SoakVerdict =
  | 'finished' | 'waiting-timer' | 'waiting-user' | 'incident' | 'active' | 'SILENT-STALL';
export interface SoakInstanceReport {
  id: string; name: string; status: string;
  cycles: number;                 // activity.timeout count = completed timer waits
  lastEventType: string | null;
  lastEventAgeMs: number | null;
  verdict: SoakVerdict;
}
export function analyzeInstance(
  inst: SoakInstanceInput,
  now: number,
  opts?: { timerSlackMs?: number; activeThresholdMs?: number },
): SoakInstanceReport
```

- [ ] **Step 1: Write the failing test**

Create `packages/server/test/soak-report.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @flowfabric/server test soak-report`
Expected: FAIL — cannot find `../src/soak/report.js`

- [ ] **Step 3: Implement `report.ts`**

Create `packages/server/src/soak/report.ts`:

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @flowfabric/server test soak-report`
Expected: PASS (6 tests)

- [ ] **Step 5: Write the CLI**

Create `packages/server/scripts/soak-report.ts` (tsx script, same convention as the probes; reads the live DB — WAL readers don't block the daemon):

```typescript
import os from 'node:os';
import path from 'node:path';
import { InstanceStore } from '../src/engine-host/store.js';
import { analyzeInstance } from '../src/soak/report.js';

const dataDir = process.env.FF_DATA_DIR ?? path.join(os.homedir(), '.flow-fabric');
const store = new InstanceStore(path.join(dataDir, 'flow-fabric.db'));
const now = Date.now();
const openIncidents = store.listOpenIncidents();
const pendingTasks = store.listPendingUserTasks();

const reports = store.listInstances().map((row) =>
  analyzeInstance(
    {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: store.listEvents(row.id).map((e) => ({ type: e.type, elementId: e.elementId, ts: e.ts })),
      openIncidents: openIncidents.filter((i) => i.instanceId === row.id).length,
      pendingUserTasks: pendingTasks.filter((t) => t.instanceId === row.id).length,
    },
    now,
  ),
);

for (const r of reports) {
  const age = r.lastEventAgeMs === null ? '-' : `${Math.round(r.lastEventAgeMs / 60_000)}m`;
  console.log(
    `${r.verdict.padEnd(13)} ${r.status.padEnd(10)} cycles=${String(r.cycles).padEnd(3)} ` +
      `last=${(r.lastEventType ?? '-').padEnd(20)} age=${age.padEnd(7)} ${r.name} (${r.id})`,
  );
}
const stalls = reports.filter((r) => r.verdict === 'SILENT-STALL').length;
const cycles = reports.reduce((sum, r) => sum + r.cycles, 0);
console.log(`\n${reports.length} instance(s), ${cycles} timer cycle(s), ${stalls} SILENT-STALL(s)`);
store.close();
process.exit(stalls > 0 ? 1 : 0);
```

- [ ] **Step 6: Smoke the CLI against a scratch dir**

```bash
cd packages/server && FF_DATA_DIR=$(mktemp -d) node --import tsx scripts/soak-report.ts
```

Expected: `0 instance(s), 0 timer cycle(s), 0 SILENT-STALL(s)`, exit 0. (An empty data dir creates a fresh DB — harmless.)

- [ ] **Step 7: Commit**

```bash
git add packages/server/src/soak/report.ts packages/server/scripts/soak-report.ts packages/server/test/soak-report.test.ts
git commit -m "feat: soak-report — daily-cycle count and silent-stall verdicts"
```

---

### Task 9: launchd unit + soak runbook

**Files:**
- Create: `ops/run-daemon.sh`
- Create: `ops/launchd/dev.flowfabric.daemon.plist`
- Create: `docs/ops/soak-runbook.md`

**Interfaces:**
- Consumes: built daemon (`packages/server/dist/daemon.js`, webRoot resolves to `packages/web/dist` from there), `.env` at repo root, soak-report CLI from Task 8
- Produces: an installable launchd agent that keeps the daemon alive 24/7

- [ ] **Step 1: Write the entrypoint script**

Create `ops/run-daemon.sh`:

```bash
#!/bin/sh
# launchd entrypoint: run the built daemon with the repo .env.
# launchd gives a minimal PATH, so resolve node explicitly — set NODE_BIN
# in the plist EnvironmentVariables if `command -v node` can't find it.
set -e
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"
NODE_BIN="${NODE_BIN:-$(command -v node || echo /opt/homebrew/bin/node)}"
mkdir -p "${FF_DATA_DIR:-$HOME/.flow-fabric}/logs"
exec "$NODE_BIN" --env-file-if-exists=.env packages/server/dist/daemon.js
```

Then: `chmod +x ops/run-daemon.sh`

- [ ] **Step 2: Write the plist template**

Create `ops/launchd/dev.flowfabric.daemon.plist` (paths carry a `REPLACE_ME` home-dir placeholder; the runbook sed-substitutes them):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.flowfabric.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>REPLACE_ME/dev/ai-engineering/flow-fabric/ops/run-daemon.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>REPLACE_ME/.flow-fabric/logs/daemon.out.log</string>
  <key>StandardErrorPath</key><string>REPLACE_ME/.flow-fabric/logs/daemon.err.log</string>
</dict>
</plist>
```

- [ ] **Step 3: Write the runbook**

Create `docs/ops/soak-runbook.md`:

```markdown
# Flow Fabric — Soak Runbook (M5.3)

Runs the daemon 24/7 under launchd for the 7-day G1 soak. KeepAlive restarts
it on any exit; `resumeAll()` recovers instances and in-flight timers (FR-9).

## Install

    pnpm build                     # daemon runs the built dist, not tsx
    sed "s|REPLACE_ME|$HOME|g" ops/launchd/dev.flowfabric.daemon.plist \
      > ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
    launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
    curl -s http://127.0.0.1:4400/api/healthz    # → {"ok":true}

Notes:
- `.env` at the repo root supplies `ANTHROPIC_*` (and `CLAUDE_CODE_PATH` if the
  agent SDK needs a pinned binary). launchd's PATH is minimal — if node isn't
  found, add `EnvironmentVariables` → `NODE_BIN` to the plist.
- Optional OTel: add `OTEL_EXPORTER_OTLP_ENDPOINT` to `.env` and keep the
  Jaeger container running. Export failures never affect execution — they only
  log to daemon.err.log.

## Daily check (~5 min)

1. `cd packages/server && node --import tsx scripts/soak-report.ts`
   — verdict per instance; exit 1 on any SILENT-STALL.
2. Open http://127.0.0.1:4400/#/inbox — answer pending user tasks, resolve
   incidents (retry / skip / abort). Incidents are *surfaced* halts and don't
   violate the soak criterion; unresolved ones block the loop, so act same-day.
3. Note the row below. Cycles must grow by 1 per day.

| Day | Date | Cycles | Verdict | Incidents (id → resolution) | Notes |
|---|---|---|---|---|---|
| 1 | | | | | |
| 2 | | | | | |
| 3 | | | | | |
| 4 | | | | | |
| 5 | | | | | |
| 6 | | | | | |
| 7 | | | | | |

## Mid-soak restart drill (once, ~day 3)

    launchctl kickstart -k gui/$(id -u)/dev.flowfabric.daemon

Then re-run the soak report: the instance must still be a healthy wait and the
next timer must fire at its originally scheduled time (FR-9 in production shape).

## Exit criteria (G1 / success criterion 1)

- ≥ 7 consecutive daily cycles on the real workspace.
- Zero SILENT-STALL verdicts all week.
- Every halt was a modeled end event or a surfaced incident/user task.

## Teardown

    launchctl bootout gui/$(id -u)/dev.flowfabric.daemon
    rm ~/Library/LaunchAgents/dev.flowfabric.daemon.plist
```

- [ ] **Step 4: Verify the unit installs and serves**

Run the Install section once against the real home dir (daemon may use the default `~/.flow-fabric` data dir). Confirm `healthz` responds, `daemon.out.log` shows the boot lines, then run the restart drill command once and confirm the daemon comes back within seconds. Leave it installed if proceeding straight to Task 10, otherwise tear down.

- [ ] **Step 5: Commit**

```bash
git add ops/run-daemon.sh ops/launchd/dev.flowfabric.daemon.plist docs/ops/soak-runbook.md
git commit -m "chore: launchd unit + soak runbook (M5.3 infrastructure)"
```

---

### Task 10: M5.2 — first real rfp-daily run, supervised

**Files:**
- Modify: `docs/specs/plan_m5-otel-soak.md` (findings in Changelog)

Manual. This is the first non-dry execution against the real RFP workspace (impl M5.2). Supervised = an operator watches the whole cycle and can abort.

- [ ] **Step 1: Pre-flight checklist**

- `.env` has a real `ANTHROPIC_API_KEY` (plus `ANTHROPIC_BASE_URL`/`ANTHROPIC_MODEL` if using a Claude-compatible endpoint, and `CLAUDE_CODE_PATH` if needed).
- The refined `rfp-daily-routine` definition (M3 output) is uploaded and its latest version is deployable (Definitions page shows zero lint errors). Re-grill first if the Input file changed since M3.
- A fresh **dry run** of that exact version completes a full cycle (stub agents, real user tasks) — this is the design §12 mitigation; do not skip.
- macOS notifications fire and deep-link to the inbox.
- Optional but recommended: Jaeger running + `OTEL_EXPORTER_OTLP_ENDPOINT` set, so the run doubles as an FR-24 demo.

- [ ] **Step 2: Start the real run**

From the Instances/Definitions UI: start an instance of the deployable version with `dryRun: false`, `workspacePath` = the real RFP workspace. Confirm the 409 workspace lock by attempting a second start (expected failure, FR-10).

- [ ] **Step 3: Supervise one full daily cycle**

- Watch the live diagram overlay and timeline (FR-20/21); answer user tasks promptly.
- Abort criteria (act immediately): agent writes outside its declared boundaries, runaway cost on a single task, or a loop that re-runs completed work. Abort via the instance Abort button — that is the supervised-run safety net.
- If an incident fires, resolve it from the inbox and note reason + resolution.

- [ ] **Step 4: Review cost (fresh-session risk, PRD §9)**

```bash
curl -s http://127.0.0.1:4400/api/metrics/definitions/$DEF | jq '.costPerRun, .costPerTask'
```

Record the per-task cost table and total cycle cost in this plan's Changelog. Open the transcript of the most expensive task (timeline → transcript link) and note how much of it is workspace re-discovery vs. actual work — this is the input for the Task 12 priming decision.

- [ ] **Step 5: Commit findings**

```bash
git add docs/specs/plan_m5-otel-soak.md
git commit -m "docs: record M5.2 first real run findings (cost per task)"
```

---

### Task 11: M5.3 — 7-day unattended soak

**Files:**
- Modify: `docs/ops/soak-runbook.md` (fill the daily log)
- Modify: `docs/specs/plan_m5-otel-soak.md` (gate record)

Manual/operational. Prerequisites: Task 9 unit installed, Task 10 cycle succeeded.

- [ ] **Step 1: Start the soak instance** — real workspace, `dryRun: false`, via the UI, with the launchd daemon (not a dev terminal). Confirm `soak-report` shows `waiting-timer` after the first cycle's timer arms.
- [ ] **Step 2: Run the daily check** from the runbook every day for 7 days; fill the log table. User tasks and incidents are answered same-day (they are surfaced halts, allowed by the criterion; multi-day unanswered ones would mask stalls).
- [ ] **Step 3: Mid-soak restart drill** (~day 3) per the runbook; record that the timer fired on original schedule.
- [ ] **Step 4: Evaluate the exit criteria** — ≥7 consecutive cycles, zero SILENT-STALL, every halt modeled or surfaced. Any stall: capture a copy of `~/.flow-fabric/flow-fabric.db`, diagnose (event log + engine_state), file the finding, fix, restart the soak clock.
- [ ] **Step 5: Commit** the completed log + gate record:

```bash
git add docs/ops/soak-runbook.md docs/specs/plan_m5-otel-soak.md
git commit -m "docs: M5.3 soak gate record — 7 consecutive cycles, zero silent stalls"
```

---

### Task 12: M5.4 — close-out: cost decision + docs

**Files:**
- Modify: `docs/specs/plan_m5-otel-soak.md` (decision record)
- Modify: `docs/specs/index.md` (M5 row → Done)
- Modify: `CLAUDE.md` ("Current state" section)

- [ ] **Step 1: Make the priming decision (PRD §9 fresh-session cost risk)**

From the Task 10/11 cost data: compute average agent-task cost and the share attributable to workspace re-discovery (transcript review). Record in this plan's Changelog one of:
- **No action** — per-cycle cost acceptable; fresh sessions stay.
- **Follow-up needed** — shared read-only context priming goes on the post-v1 backlog, with the measured numbers as justification. (Do not implement it in M5 — out of scope.)

- [ ] **Step 2: Update the docs to built state**

- `CLAUDE.md`: "M1–M4 are built; M5 is not" → M1–M5 built; add `telemetry/` and `soak/` to the module list; note the OTel gate env var and the graceful-shutdown handler; remove OTel from the "Not built" line.
- `docs/specs/index.md`: M5 row → `[plan_m5-otel-soak.md](plan_m5-otel-soak.md)` / Done.

- [ ] **Step 3: Full verification**

Run: `pnpm build && pnpm test`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/specs/index.md docs/specs/plan_m5-otel-soak.md
git commit -m "docs: M5 close-out — cost decision, docs to built state"
```

(After shipping, `/spec-compact` this plan per project convention.)

---

## Spec Coverage (self-review)

| Spec item | Where |
|---|---|
| FR-24 trace per instance, span per task, attributes (node id, actor, attempt, tokens, cost) | Tasks 2–3 |
| FR-24 OTLP exporter, config-gated, off by default | Task 4, verified Task 7 step 5 |
| Design §10 counters (task success/failure, incidents) + histograms (task/run duration, cost) | Tasks 2–3 |
| Design §10 "every event append emits an OTel span/event" | Event log replayed as root-span events (Task 3); see Design Decisions for the post-hoc rationale |
| Design §10 structured platform logs (FR-25) | Already shipped in M4 (`LogRing`); no M5 work |
| Impl M5.1 gate: spans visible in local collector for a dry run | Task 7 |
| Impl M5.2 first real run + cost review | Task 10 |
| Impl M5.3 launchd/pm2 + 7-day soak, zero silent stalls | Tasks 9, 11 (+ Task 8 makes the gate checkable) |
| Impl M5.4 cost measurement + priming decision | Task 12 |

## Changelog

- 2026-07-20 — Plan created.
