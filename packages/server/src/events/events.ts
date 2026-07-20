import { EventEmitter } from 'node:events';
import type { EventRow, InstanceRow, TaskExecutionRow } from '../engine-host/store.js';
import { NOOP_TELEMETRY, type FinishedInstanceStatus, type Telemetry } from '../telemetry/telemetry.js';

/** An event as written by producers (EngineHost, Inbox, dispatch, failure). */
export interface DomainEvent {
  instanceId: string;
  type: string;
  elementId?: string;
  detail?: string;
}

/** The materialized event fanned out to subscribers (SSE payload shape). */
export interface EmittedEvent {
  instanceId: string;
  seq: number;
  type: string;
  elementId: string | null;
  detail: string | null;
  ts: number;
}

/**
 * The narrow persistence port Events depends on. Implemented by InstanceStore;
 * every method already exists there.
 */
export interface EventStore {
  /** INSERT the row, return its seq. No fan-out (that is Events' job). */
  insertEvent(instanceId: string, type: string, elementId?: string, detail?: string): number;
  listEvents(instanceId: string): EventRow[];
  getInstance(id: string): InstanceRow | undefined;
  getTaskExecution(id: number): TaskExecutionRow | undefined;
}

export interface EventFilter {
  instanceId?: string;
}

/**
 * The `events` module the design (§3) names: a single write path (`append`),
 * SSE fan-out (`subscribe`), and OTel emission (the three telemetry drivers,
 * which own span-payload assembly + terminal-transition dedup). InstanceStore
 * is a pure persistence adapter behind it; SSE and OTel are two more adapters
 * at the same seam.
 */
export class Events {
  private emitter = new EventEmitter();
  private ended = new Set<string>();

  constructor(private store: EventStore, private telemetry: Telemetry = NOOP_TELEMETRY) {
    this.emitter.setMaxListeners(0); // one listener per SSE connection
  }

  /** Single write path: persist the row, then fan out the materialized event. */
  append(event: DomainEvent): void {
    const ts = Date.now();
    const seq = this.store.insertEvent(event.instanceId, event.type, event.elementId, event.detail);
    const emitted: EmittedEvent = {
      instanceId: event.instanceId,
      seq,
      type: event.type,
      elementId: event.elementId ?? null,
      detail: event.detail ?? null,
      ts,
    };
    this.emitter.emit('event', emitted);
  }

  /** Register an SSE listener (optionally filtered). Returns an unsubscribe fn. */
  subscribe(listener: (event: EmittedEvent) => void, filter: EventFilter = {}): () => void {
    const wrapped = (event: EmittedEvent) => {
      if (filter.instanceId && event.instanceId !== filter.instanceId) return;
      listener(event);
    };
    this.emitter.on('event', wrapped);
    return () => this.emitter.off('event', wrapped);
  }

  /**
   * Terminal-transition dedup + span-payload assembly, then telemetry.instanceEnded.
   * Fires at most once per instance (the dedup Set); the enabled gate keeps NOOP
   * runs from paying the assembly SELECTs. Skips unknown rows.
   */
  instanceEnded(instanceId: string, status: FinishedInstanceStatus): void {
    if (!this.telemetry.enabled) return;
    if (this.ended.has(instanceId)) return;
    const row = this.store.getInstance(instanceId);
    if (!row) return;
    this.ended.add(instanceId);
    this.telemetry.instanceEnded({
      instanceId,
      name: row.name,
      status,
      startedAt: row.createdAt,
      endedAt: row.updatedAt,
      definitionId: row.definitionId ?? undefined,
      versionNo: row.versionNo ?? undefined,
      dryRun: row.dryRun,
      events: this.store
        .listEvents(instanceId)
        .map((e) => ({ type: e.type, elementId: e.elementId, ts: e.ts })),
    });
  }

  /** Reads the finished task_execution row via the port, then telemetry.taskExecution. */
  taskExecution(recId: number): void {
    if (!this.telemetry.enabled) return;
    const row = this.store.getTaskExecution(recId);
    if (!row) return;
    this.telemetry.taskExecution({
      instanceId: row.instanceId,
      nodeId: row.nodeId,
      actor: row.actor,
      attempt: row.attempt,
      status: row.status as 'completed' | 'failed',
      startedAt: row.startedAt,
      endedAt: row.endedAt ?? Date.now(),
      error: row.error ?? undefined,
      tokenUsage: row.tokenUsage ?? undefined,
      costUsd: row.costUsd ?? undefined,
    });
  }

  incidentRaised(nodeId: string): void {
    if (!this.telemetry.enabled) return;
    this.telemetry.incidentRaised(nodeId);
  }
}
