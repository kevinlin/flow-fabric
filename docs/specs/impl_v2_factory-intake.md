# Flow Fabric — Implementation Spec v2: Factory Intake

| | |
|---|---|
| Status | Draft |
| Date | 2026-07-22 |
| Design | [design_v2_factory-intake.md](design_v2_factory-intake.md) |

Five milestones, each with numbered tasks and a verification gate. TDD rhythm as in v1: failing test first, task by task. V2 builds before M5 (OTel + soak), so the eventual soak exercises intake too; [plan_m5-otel-soak.md](plan_m5-otel-soak.md) gets a note.

## V2-M1 — Input contract: `inputSchema` end to end

Goal: the typed process-level input contract replaces `instanceInputs` everywhere; every existing deployable definition stays deployable after re-refinement.

1. Shared: moddle descriptor swaps `flowfabric:InstanceInputs` for process-level `flowfabric:InputSchema`; profile types replace `instanceInputs: InputDecl[]` with `inputSchema?: object`; API DTO updates.
   - Verify: moddle round-trips a fixture carrying `inputSchema`; types compile across packages.
2. `profile/read.ts` reads `inputSchema` into `ProcessProfile`.
   - Verify: unit test on fixture; absent schema → `undefined`.
3. Linter FF004 reads declared inputs from the schema's top-level `properties`; message text updated.
   - Verify: rule tests. Variable in `properties` passes, absent schema flags undeclared references; fixture with old `InstanceInputs` gets flagged (declares nothing).
4. Patch op `setInputSchema(schema)` replaces `declareInstanceInput`; grill prompt updated.
   - Verify: round-trip test; op applied, DI byte-identical outside the process element.
5. Instance start validates `inputs` against the version's `inputSchema` (Ajv, existing machinery).
   - Verify: bad input rejected with errors; schema-less definition accepts anything.
6. Web: Instances start form renders `SchemaForm` from `inputSchema` (flat-list rendering removed); local BPMN files re-refined via grill.
   - Verify: component test; both local files lint deployable with `inputSchema`.

## V2-M2 — Queue: durable jobs, one gate, dispatcher, wrapper

Goal: all work enters through one validated, deduplicated, durable queue; busy workspace means wait, not 409.

1. `queue` store: `jobs` table + migration, status lifecycle, dedup key (hash over `{workflow, workspace, input, version, dryRun}`) with partial unique index on pending.
   - Verify: dedup enqueue returns the existing job; distinct envelopes never drop.
2. Enqueue gate: workflow exists → resolve validation target (pin or latest deployable) → Ajv-validate → dedup → pending row + `job.enqueued`.
   - Verify: gate tests per rejection reason; no-deployable-version and unknown-pin reject.
3. Dispatcher: triggers (enqueue, instance terminal event, boot), per-workspace FIFO, `FF_MAX_CONCURRENT` cap (default 3), claim via guarded UPDATE, dequeue re-validation + version resolution, instance linkage, terminal finalization (`done`/`failed` mirroring the instance).
   - Verify: compose+HTTP tests. Busy workspace waits then runs FIFO; different workspaces run concurrently under the cap; re-validation failure lands `failed` with reason.
4. Crash recovery: boot pass fixes `starting`-without-instance (→ pending) and `running`-with-terminal-instance (→ finalized).
   - Verify: rebuild-on-same-dataDir tests per state.
5. Direct-start wrapper: `POST /api/instances` enqueues + immediate dispatch attempt; 201 `{instance, jobId}` started / 202 `{jobId}` queued; 409 path removed; web start form handles 202.
   - Verify: API tests for both codes; existing 409 tests rewritten to expect queuing.
6. API + SSE: `POST/GET /jobs`, `GET /jobs/:id`; events `job.enqueued/started/done/failed`.
   - Verify: SSE vocabulary test extended; job list filters by status.

## V2-M3 — Scheduler: cron cadence, fire-once, timer source

Goal: cadence is controller configuration; a closed laptop neither skips nor replays.

1. `Clock` seam through `createDaemon` (real default, fake in tests).
   - Verify: compose test; daemon builds with fake clock, no real timers armed.
2. `schedules` table + CRUD API (`POST/GET/PATCH/DELETE /api/schedules`); create/update parse cron (croner) and validate stored `input` against the current latest-deployable schema.
   - Verify: bad cron and bad input rejected at save; pause via `enabled` PATCH.
3. Tick firing: per enabled schedule, arm next occurrence, enqueue `{source: 'timer'}` on fire, re-arm. Gate rejection at tick lands a `failed` job row.
   - Verify: fake-clock cadence test (≥3 ticks); schema-drift-at-tick lands visible `failed` row.
4. Fire-once coalescing: on boot/enable, one enqueue if the latest occurrence ≤ now postdates `last_fired_at`; `last_fired_at = now`.
   - Verify: rebuild after simulated downtime spanning N ticks → exactly one job; dedup absorbs the race with a live tick.
5. SSE: `schedule.created/updated/deleted/fired`; `GET /schedules` returns computed next-fire.
   - Verify: vocabulary test; next-fire matches croner.

## V2-M4 — Chaining + library description

Goal: A finishing enqueues B through the same gate; pipelines rehearse dry end to end.

1. `CodeRunner` env injection: `FF_ENQUEUE_URL`, `FF_DRY_RUN`, `FF_INSTANCE_ID` threaded via `RunContext`; composition root provides the daemon's own base URL.
   - Verify: runner test asserts env; compose wires the bound port.
2. Chain fixture pair: definition A ends in an enqueue `scriptTask` (curl `--fail`, `source: 'chain'`, `producerInstanceId`), B declares `inputSchema`.
   - Verify: compose+HTTP test. A completes, B's job appears (source `chain`, producer linked), B runs after A is terminal.
3. Chain failure: gate rejection → non-zero exit → producer's failure ladder.
   - Verify: bad envelope in the fixture → A's terminal task raises an incident after retries.
4. Dry-run rehearsal: `passthroughNodes` on instance start + job row; listed nodes run real, rest stubbed; `FF_DRY_RUN` forwarded so B enqueues dry.
   - Verify: A dry with passthrough enqueue node → B lands as a dry job and completes stubbed.
5. `definitions.description`: guarded migration, `PATCH /definitions/:id`, included in list.
   - Verify: set + list round-trip.

## V2-M5 — Web: Queue page, schedule CRUD, description

Goal: full intake UI; no intake state is API-only.

1. Queue page: manual enqueue form (definition picker → `SchemaForm` from `inputSchema`, raw-JSON escape hatch, dry-run toggle, optional pin) + live job list (status, source, workflow, workspace, instance link, reason) over SSE.
   - Verify: component tests; enqueue from browser lands a running instance.
2. Schedules section: CRUD forms (cron with next-fire preview, `SchemaForm` input, pause toggle, delete).
   - Verify: component tests; create/pause/delete round-trip against the live daemon.
3. Definitions page description display + edit; System page scheduler view adds schedules.
   - Verify: component tests; System shows next fires.
4. Nav + polish pass per PRODUCT.md principles (never silently stall: failed jobs visible with reason).
   - Verify: manual walkthrough; every job state reachable in the UI.

## Dependencies and ordering

- V2-M1 first: the gate validates against `inputSchema`, so the contract lands before the queue.
- V2-M2 before M3 and M4 (both are enqueue sources). M3 and M4 are independent of each other.
- V2-M5 last; needs M2–M4 endpoints.

## Out of scope (PRD)

Hierarchical call-and-return composition; watched-folder/webhook/Slack sources; worktrees and parallel attempts; multi-user/remote; pipeline-watching dashboards; tags/search/catalog; queue priorities. Direct references: [prd_v2_factory-intake.md § Out of Scope](../product/prd_v2_factory-intake.md#out-of-scope).
