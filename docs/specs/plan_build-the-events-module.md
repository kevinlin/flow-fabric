# Plan — Build the `events` module (architecture review §1)

## Context

The design spec (§3) names an `events` module — *"single write path, SSE fan-out, OTel emission"* — but it was never built. Its jobs landed inside `InstanceStore`, so the persistence DAO is also the event bus and the telemetry emitter:

- **Persistence assembles span payloads.** A terminal `setStatus` re-SELECTs the whole instance row *and* the full event list purely to build the `instanceEnded` telemetry payload ([store.ts:220-239](packages/server/src/engine-host/store.ts#L220-L239)).
- **Persistence holds live SSE listener state.** The `EventEmitter` field + `setMaxListeners(0)` + `onEvent()` fan-out live in the store ([store.ts:100](packages/server/src/engine-host/store.ts#L100), [:256-260](packages/server/src/engine-host/store.ts#L256-L260)).
- **The lifecycle owner has no telemetry.** `EngineHost`, which owns the run, holds no telemetry reference; telemetry fires as a hidden side-effect of store methods (`setStatus`, `finishTaskExecution`, `createIncident`).

**Fix (review §1, "Strong" / full-faithful carve):** extract an `events` module whose interface is `append(event)` + `subscribe(filter)`, with span-payload assembly, terminal-transition dedup, and fan-out as its implementation. `InstanceStore` drops to a pure persistence adapter behind it (emitter field and `{telemetry?}` option gone); SSE and OTel become two more adapters at the same seam.

**Outcome:** span bugs concentrate in one module; one `subscribe` interface serves N consumers; tests assert spans by subscribing to `events`, not by faking telemetry inside the store; the design spec and the code finally agree that `events` is a real module. This is a behavior-preserving structural refactor (telemetry stays NOOP by default) that de-risks M5's OTel wiring — after it, M5.1 is a one-file change.

Decisions (confirmed): **full faithful carve** (all telemetry leaves the store, store loses its `{telemetry?}` option); land **now as a standalone post-M4 refactor**, logged in plan_m4's changelog. The composition root (review §2) already shipped ([compose.ts](packages/server/src/compose.ts), commit `ca404b6`), so this is a one-file wiring change there, not an eleven-file tax.

## Target design

New module `packages/server/src/events/events.ts` — class `Events`.

**Public interface** (headline = the two the design names; the three telemetry drivers concentrate span assembly here):

```ts
append(event: DomainEvent): void            // single write path: persist row → fan-out → (telemetry on terminal is via instanceEnded)
subscribe(listener, filter?): () => void    // register SSE listener (optional { instanceId }); returns unsubscribe
instanceEnded(instanceId, status): void     // terminal-transition dedup + span-payload assembly, then telemetry.instanceEnded
taskExecution(recId: number): void          // reads the task_execution row via the port, then telemetry.taskExecution
incidentRaised(nodeId: string): void        // telemetry.incidentRaised
```

**Ports it depends on** (a narrow `EventStore` interface, implemented by `InstanceStore` — all methods already exist):

```ts
interface EventStore {
  insertEvent(instanceId, type, elementId?, detail?): number  // INSERT, returns seq — NO emit (renamed from appendEvent, emit stripped)
  listEvents(instanceId): EventRow[]
  getInstance(id): InstanceRow | undefined
  getTaskExecution(id): TaskExecutionRow | undefined
}
```

**Three adapters at the seam** (review's "After" diagram): SQLite persistence (`InstanceStore`), SSE stream (the `/api/events` route), OTel spans+metrics (`Telemetry`). `Events` owns the emitter, the dedup `Set<string>` of ended instances, and the span-payload assembly.

**Dependency direction:** `Events` → `InstanceStore` (port) + `Telemetry`. Everyone who writes events (`EngineHost`, `Inbox`, dispatch, failure) → `Events`. Resolves the review's complaint that `EngineHost` owns the lifecycle but has no telemetry — it now holds `events` and calls `events.instanceEnded` on terminal transitions.

## Tasks (TDD — failing test first per task)

1. **Create `events` module + its tests.** New `packages/server/src/events/events.ts` (`Events`, `DomainEvent`, `EmittedEvent`, `EventStore` port) and `packages/server/test/events.test.ts`. Cover: `append` persists via the port and fans out the materialized `{ instanceId, seq, type, elementId, detail, ts }` to subscribers; `subscribe` filter by `instanceId`; unsubscribe stops delivery; `instanceEnded` fires `telemetry.instanceEnded` once per instance (dedup Set) with the event log assembled from the port, skips unknown rows; `taskExecution(recId)` reads the row and forwards; `incidentRaised` forwards. Inject a `fakeTelemetry()` spy + an in-memory/real `InstanceStore` — assert telemetry **by observing the injected spy through `Events`**, never inside the store.

2. **Strip event + telemetry concerns from `InstanceStore`.** Delete the `emitter` field + `setMaxListeners` ([store.ts:100](packages/server/src/engine-host/store.ts#L100), [:106](packages/server/src/engine-host/store.ts#L106)), the `onEvent` method ([:256-260](packages/server/src/engine-host/store.ts#L256-L260)), the `telemetry` field + `{telemetry?}` constructor option ([:101](packages/server/src/engine-host/store.ts#L101), [:103-104](packages/server/src/engine-host/store.ts#L103-L104)), and all three telemetry call sites (`setStatus` [:221](packages/server/src/engine-host/store.ts#L221)/[:225-238](packages/server/src/engine-host/store.ts#L225-L238), `finishTaskExecution` ~[:383-386](packages/server/src/engine-host/store.ts#L383-L386), `createIncident` ~[:419](packages/server/src/engine-host/store.ts#L419)). Rename `appendEvent` → `insertEvent`: keep the INSERT, `return Number(result.lastInsertRowid)`, drop the `emitter.emit`. `setStatus` becomes a pure UPDATE; `finishTaskExecution`/`createIncident` keep persisting and returning their row/id. Drop the `EventEmitter` and `Telemetry` imports.

3. **Wire `Events` into `compose.ts`.** Construct `store` without the telemetry option; `const events = new Events(store, telemetry)`; pass `events` to `EngineHost`, `Inbox`, and `buildApi`. Expose `events` on the `Daemon` interface. `Daemon.close()` teardown order unchanged — `telemetry.shutdown()` still owned here (Events doesn't own telemetry lifecycle). Delete the "deliberate asymmetry" comment at [compose.ts:50-53](packages/server/src/compose.ts#L50-L53) (NOOP no longer reaches the store).

4. **Repoint the event/telemetry writers (~5 files, mechanical).** Replace `store.appendEvent(id, type, el, detail)` → `events.append({ instanceId: id, type, elementId: el, detail })` in [engine-host.ts](packages/server/src/engine-host/engine-host.ts) (hot path ~[:263](packages/server/src/engine-host/engine-host.ts#L263) + abort/incident/engine events), [inbox.ts:19](packages/server/src/inbox/inbox.ts#L19)/[:37](packages/server/src/inbox/inbox.ts#L37), [failure.ts:57](packages/server/src/engine-host/failure.ts#L57)/[:65](packages/server/src/engine-host/failure.ts#L65). On terminal transitions in `engine-host.ts` (~[:301](packages/server/src/engine-host/engine-host.ts#L301)/[:303](packages/server/src/engine-host/engine-host.ts#L303)/[:312](packages/server/src/engine-host/engine-host.ts#L312)), call `events.instanceEnded(id, status)` right after `store.setStatus`. After `store.finishTaskExecution(...)` in [dispatch.ts:75](packages/server/src/engine-host/dispatch.ts#L75)/[:85](packages/server/src/engine-host/dispatch.ts#L85) and [inbox.ts:39](packages/server/src/inbox/inbox.ts#L39), call `events.taskExecution(recId)`. After `store.createIncident(...)` in [failure.ts:63](packages/server/src/engine-host/failure.ts#L63), call `events.incidentRaised(nodeId)`. Add `events` to `EngineHost`/`Inbox`/dispatch/failure constructor deps.

5. **Repoint the SSE route.** [api/server.ts:157](packages/server/src/api/server.ts#L157) `store.onEvent(...)` → `deps.events.subscribe(...)`. Move the per-listener `instanceId` filter ([:158](packages/server/src/api/server.ts#L158)) into the `subscribe(listener, { instanceId })` filter arg (matches the named `subscribe(filter)` signature). Add `events` to `ApiDeps` ([api/server.ts:25-33](packages/server/src/api/server.ts#L25-L33)).

6. **Update the barrel + migrate tests.** [index.ts](packages/server/src/index.ts): export `Events` + `EmittedEvent`/`DomainEvent` types; the store still exports `EventRow`. Migrate the six affected test files:
   - `telemetry-store.test.ts` → fold into `events.test.ts` (inject fake telemetry into `Events`, not the store; the store no longer takes `{telemetry}`).
   - `api.test.ts` SSE test — daemon now wires `events`; route unchanged externally, should stay green.
   - `events-vocab.test.ts` — asserts via `store.listEvents`, still valid (appends now flow `events.append` → `store.insertEvent`).
   - `compose.test.ts` — teardown-order test still injects fake `Telemetry`; `telemetry.shutdown` still called by `Daemon.close`. Update construction if it touched the store telemetry option.
   - `telemetry.test.ts` — pure `OtelTelemetry`, untouched.
   - Any test constructing `new InstanceStore(path, { telemetry })` directly → construct `Events` instead.

## Doc updates (part of this change)

**`docs/specs/design_flow-fabric.md`:**
- **§3** — add an amendment paragraph after the composition-root one (2026-07-20), stating the `events` module (row already in the table) is now built as its own module: M4 had folded its jobs into `InstanceStore`; this change extracts them so code matches the named seam. Note the interface (`append`/`subscribe` + the telemetry-driver methods), the three adapters (SQLite persistence, SSE, OTel), and that `InstanceStore` is now pure persistence (no emitter, no telemetry option) with `EngineHost` holding the `events` reference.
- **§8 (SSE)** — one line: the `GET /api/events` stream is now served by `events.subscribe(filter)`, not `store.onEvent`. Vocabulary unchanged.
- **§10 (Observability)** — reconcile "Every event append emits an OTel span/event" with reality: the `events` module is the single place that drives OTel (span assembly + dedup), rather than the persistence layer.
- **§11 (Testing)** — add/adjust a row: events module — `append`/`subscribe` fan-out + span assertions via subscription (replaces the store↔telemetry coupling test).

**`docs/specs/plan_m4-web-ui.md`** — append a Changelog entry dated 2026-07-20 (sibling of the composition-root entry): *"Events module carve-out (architecture review §1)"* — summarize the extraction, the store shrink (emitter + `{telemetry?}` gone), the SSE/telemetry adapter repointing, `EngineHost` gaining the telemetry reference, test migration (`telemetry-store.test.ts` → `events.test.ts`), and the behavior-preserving / M5-de-risking rationale. Note final suite counts after implementation.

## Critical files

| Path | Change |
|---|---|
| `packages/server/src/events/events.ts` | **New** — `Events` class, `DomainEvent`/`EmittedEvent`/`EventStore` types |
| `packages/server/src/engine-host/store.ts` | Strip emitter + telemetry; `appendEvent`→`insertEvent` (no emit); `setStatus` pure |
| `packages/server/src/compose.ts` | Construct `Events`, inject into host/inbox/api; expose on `Daemon` |
| `packages/server/src/engine-host/engine-host.ts` | Hold `events`; `append` calls; `instanceEnded` on terminal |
| `packages/server/src/engine-host/{dispatch,failure}.ts` | `events.append` + `taskExecution`/`incidentRaised` handoffs |
| `packages/server/src/inbox/inbox.ts` | `events.append` + `taskExecution` handoff |
| `packages/server/src/api/server.ts` | `ApiDeps.events`; SSE route → `events.subscribe(filter)` |
| `packages/server/src/index.ts` | Export `Events` + types |
| `packages/server/test/events.test.ts` | **New** — folds `telemetry-store.test.ts` |
| design_flow-fabric.md · plan_m4-web-ui.md | §3/§8/§10/§11 amendment + changelog entry |

## Verification

- **TDD loop:** `events.test.ts` fails first, passes after task 1; each caller edit keeps the suite green.
- **Full suite:** `pnpm --filter @flowfabric/server test` green (note the [real-timer flakiness](../.claude/projects/-Users-kevinlin-dev-ai-engineering-flow-fabric/memory/server-test-parallel-flakiness.md) — re-run the server suite isolated if loop/resume/scheduler flake). Then `pnpm build && pnpm test` across the workspace; web/shared untouched.
- **Behavior-preserving checks:** SSE end-to-end still streams (`api.test.ts`); event vocabulary intact (`events-vocab.test.ts`); teardown order `stopAll → app.close → telemetry.shutdown → store.close` intact (`compose.test.ts`).
- **Telemetry parity:** with a fake telemetry injected into `Events`, a terminal dry run fires exactly one `instanceEnded` (dedup holds) with the full event log; task finishes fire `taskExecution`; an incident fires `incidentRaised` — same signals the store produced before, now asserted through the `events` seam.
- **`tsc` clean** (strict, NodeNext) — the store no longer imports `EventEmitter`/`Telemetry`; no dangling `onEvent`/`appendEvent`/`{telemetry?}` references.
