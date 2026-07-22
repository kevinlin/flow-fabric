# Flow Fabric — Design Spec v2: Factory Intake

| | |
|---|---|
| Status | Draft |
| Date | 2026-07-22 |
| PRD | [prd_v2_factory-intake.md](../product/prd_v2_factory-intake.md) |
| Implementation | [impl_v2_factory-intake.md](impl_v2_factory-intake.md) |
| Baseline | [design_flow-fabric.md](design_flow-fabric.md) (v1, approved) |

Adds the factory intake path to the v1 daemon: a durable job queue with one enqueue gate, a timer-enqueue scheduler, pipeline chaining through that same gate, and a typed process-level input contract. Everything on the intake path is deterministic code; no agent output influences enqueue, dispatch, version resolution, or validation.

## 1. Architecture decision

Two new server modules, `queue` and `scheduler`, beside the existing ones. `engine-host` is untouched: the dispatcher calls `host.start()` and listens to `Events` for terminal transitions, the same seams the API uses today.

Alternatives considered:

- **Fold queue + dispatch into `engine-host`**: fewer modules, but engine-host already owns lifecycle, persistence, and resume; intake is a different purpose. Rejected.
- **Separate worker process**: isolation the solo-local daemon does not need, plus a second thing to supervise. Rejected.

## 2. Module additions

| Module | Purpose | Key interface |
|---|---|---|
| `queue` | Durable job store + enqueue gate (validation, dedup) + dispatcher (FIFO per workspace, global cap) | `enqueue(envelope, meta): Job`, `list(filter)`, `get(id)`, dispatcher wired to `Events` |
| `scheduler` | Schedule CRUD + cron tick firing on an injectable clock; fire-once coalescing | `create/update/delete/list`, `start()`, `stop()` |

Touched modules: `profile` (+ shared moddle descriptor) for `inputSchema`; `linter` (FF004 reads the schema); `patch-ops` (`declareInstanceInput` → `setInputSchema`); `grill` (prompt knows the new op); `definitions` (`description` column); `runners` (`CodeRunner` env injection); `api` (jobs + schedules routes, direct-start wrapper); `compose` (constructs queue, scheduler, clock; teardown order); `web` (Queue page, form switches).

New dependency: `croner` (cron parsing + next/previous occurrence; zero-dep, TS).

## 3. Data model (same SQLite)

| Table | Key columns |
|---|---|
| `jobs` | id, workflow_id, workspace_path, input (JSON), version_pin (nullable INT), enrichment (JSON, nullable, opaque), dry_run, passthrough_nodes (JSON, nullable), source (`manual/timer/chain`), producer_instance_id (nullable), status (`pending/starting/running/done/failed`), reason (nullable), instance_id (nullable), resolved_version (nullable), dedup_key, created_at, started_at, ended_at |
| `schedules` | id, workflow_id, workspace_path, input (JSON), cron (5-field), enabled, last_fired_at (nullable), created_at, updated_at |

- **Dedup key**: hash of canonical JSON over `{workflow, workspace, input, version, dryRun}`, enforced by a partial unique index `WHERE status = 'pending'`. `dryRun` extends the PRD's identity tuple: without it a pending dry rehearsal would swallow a live enqueue of the same envelope. An identical enqueue returns the existing pending job (no-op).
- **Job status is engine truth**: `failed` means the job could not start (validation failure, no deployable version, missing pin target) *or* its instance was aborted; `done` means the instance reached `completed` or `terminated`. `reason` says which; `instance_id` links the full outcome (jobs → instance → timeline, end to end).
- Schedules store no next-fire; it is computed from `cron` on read. Migrations follow the existing guard pattern (`CREATE TABLE IF NOT EXISTS`; `ALTER TABLE definitions ADD COLUMN description` guarded like the M4 `instances.definition_id` migration).

## 4. Enqueue gate

One gate, four callers: manual API, scheduler, chain command, and the direct-start wrapper. Steps:

1. Workflow must exist.
2. Resolve the validation target: the pinned version if `version` is set, else the latest deployable version. No target → reject (`no deployable version` / `unknown version pin`).
3. Ajv-validate `input` against that version's `inputSchema`. A workflow without `inputSchema` accepts any input.
4. Dedup check (above). Insert `pending` row, emit `job.enqueued`.

Rejection surfaces per source:

- **Manual** → HTTP 400 with the validation errors (the operator is watching; no row).
- **Chain** → non-2xx → the command exits non-zero → the producer's terminal `scriptTask` fails into the existing failure ladder (retry → boundary → incident). No row.
- **Timer** → a `failed` job row with the reason. The scheduler has no request/response channel, so the row is its visibility; a swallowed error would be a silent stall.

**Dequeue re-validation (the durable-queue defense).** At dispatch, the version is resolved again (pin → exact; none → latest deployable *at dequeue*, so the local edit/redeploy loop picks up fixes for queued jobs) and `input` is re-validated against the resolved version's schema. Any failure — schema drift since enqueue, pin now missing or undeployable, hand-edited row — moves the job to `failed` with a reason instead of crash-looping.

## 5. Dispatcher

- **Triggers**: a job enqueued, any instance terminal transition (via `Events`), and boot.
- **Selection**: oldest pending job per free workspace (per-workspace FIFO), skipping workspaces with an active instance, until the global cap is reached. Cap counts active instances (`running/waiting/incident`), configured by `FF_MAX_CONCURRENT` (default 3).
- **Claim**: `UPDATE jobs SET status='starting' WHERE id=? AND status='pending'`; a single serialized dispatch pass per trigger, so no double-claim. The `one_active_per_workspace` unique index stays the ultimate gate — if a race slips through, the failed `start()` returns the job to `pending` for the next pass.
- **Lifecycle**: `starting` → resolve + re-validate + `host.start()` → `running` (instance linked, `job.started`) → on the instance's terminal event, `done` or `failed` (`job.done` / `job.failed`).
- **Crash recovery at boot**: `starting` with no instance → back to `pending`; `running` whose instance is already terminal → finalized; `running` with a live instance → left alone (`resumeAll()` owns the instance).

## 6. Direct start becomes a wrapper

`POST /api/instances` enqueues through the same gate and attempts an immediate dispatch:

- Workspace free and under cap → job goes straight to `running` → **201** `{instance, jobId}` (response keeps the instance payload the web start form expects).
- Workspace busy or cap reached → **202** `{jobId}`, job waits its turn.

The 409-on-busy behavior is removed (PRD story 3: wait, never drop). Existing 409 tests and the web start form change accordingly. The queue is the only intake path.

## 7. Chain runtime

`CodeRunner` gains three env vars, threaded through `RunContext`: `FF_ENQUEUE_URL` (the daemon's own `/api/jobs`), `FF_DRY_RUN` (`0`/`1`), `FF_INSTANCE_ID`. A chain is a terminal `scriptTask` whose command POSTs the successor envelope:

```sh
curl --fail -s -X POST "$FF_ENQUEUE_URL" -H 'content-type: application/json' -d "{
  \"workflow\": \"submission-prep\", \"workspace\": \"$PWD\",
  \"input\": {...}, \"source\": \"chain\",
  \"producerInstanceId\": \"$FF_INSTANCE_ID\", \"dryRun\": $FF_DRY_RUN
}"
```

`--fail` maps a gate rejection to a non-zero exit, which is how the failure ladder engages. Conditional chains are exclusive gateways routing to different enqueue tasks. No new BPMN elements, no linter changes.

**Dry-run rehearsal.** Dry-run stubs code tasks, which would stub the enqueue command and break the chain. Instance start (and the job row) therefore accepts `passthroughNodes: string[]` — listed nodes run their real runner while everything else stays stubbed. The chain command forwards `FF_DRY_RUN` into the successor envelope, so the whole pipeline rehearses as dry jobs through the real queue (PRD story 28). A separate field, not a magic value inside `stubOverrides`, so contract output shapes stay arbitrary.

The composition root threads the daemon's own base URL into the runner env; tests use the ephemeral bound port.

## 8. Profile change: `inputSchema` replaces `instanceInputs`

- Shared moddle descriptor: process-level `flowfabric:InputSchema` (JSON Schema as text, the `formSchema` pattern) replaces `flowfabric:InstanceInputs`. `ProcessProfile.instanceInputs` → `inputSchema?: object`.
- Linter FF004 treats the schema's top-level `properties` as the declared instance inputs; absent schema = no declared inputs (referenced variables must then be produced upstream). Message text updates; rule id stays.
- Patch op `declareInstanceInput` is replaced by `setInputSchema(schema)`; the grill system prompt learns the new op.
- Old files carrying `InstanceInputs` parse but declare nothing, so FF004 flags their variables — re-refine via grill. Both local BPMN files (untracked) are refreshed as part of the build.
- `definitions` gains nullable `description`, settable via the API, shown in the definitions list.

## 9. API + SSE

REST (all under `/api`):

- `POST /jobs` (envelope + `dryRun?`, `passthroughNodes?`, `source?` default `manual`, `producerInstanceId?`) → 201 new / 200 existing-on-dedup / 400 rejected. `GET /jobs?status=&workflow=`, `GET /jobs/:id`.
- `POST /schedules`, `GET /schedules` (each with computed next-fire), `PATCH /schedules/:id` (edit + pause via `enabled`), `DELETE /schedules/:id`. Create/update parse the cron and validate the stored `input` against the current latest-deployable schema — a bad schedule fails at save, visibly.
- `PATCH /definitions/:id` `{description}`.
- `POST /instances` per §6. `GET /scheduler` (BPMN timer registry) is unchanged.

SSE additions to the existing stream: `job.enqueued/started/done/failed`, `schedule.created/updated/deleted/fired`.

## 10. Scheduler internals

- **Clock seam**: `Clock` (now + timer arm/cancel) injected through `createDaemon`, real-clock default — the same inert-default pattern as runners and notifier. Tests drive a fake clock; no real-timer sleeps (the known parallel-flakiness trap).
- **Ticking**: per enabled schedule, arm a timer for the next cron occurrence; on fire, enqueue `{source: 'timer'}` and re-arm. Each tick is a fresh independent instance; intra-workflow recurrence loops (the flagship) stay untouched.
- **Fire-once coalescing**: on boot and on enable, compute the most recent occurrence ≤ now; if it is after `last_fired_at`, enqueue exactly once and set `last_fired_at = now`. Any number of missed ticks collapse into that one fire; queue dedup absorbs races.

## 11. Web UI

New **Queue** page (nav order: Definitions, Refine, Instances, Queue, Inbox, Dashboards, System):

- Manual enqueue: pick a definition → `SchemaForm` rendered from its latest deployable `inputSchema` (raw-JSON escape hatch as today), dry-run toggle, optional version pin.
- Job list: status, source, workflow, workspace, instance link, failure reason; live via the existing SSE client.
- Schedules section, full CRUD: cron field with computed next-fire preview, workspace, input via `SchemaForm`, pause toggle, delete.

Elsewhere: Definitions page shows and edits `description`; the Instances start form switches from the flat input list to `SchemaForm` and renders the 202-queued outcome; the System page scheduler view adds schedules + next fires from `GET /api/schedules`.

## 12. Testing strategy

| Layer | Approach |
|---|---|
| Queue | Order (per-workspace FIFO), serialization (busy → wait), dedup no-op, cap; via compose root + HTTP, asserting only API responses, SSE events, and job/instance states |
| Scheduler | Fake clock: cadence, fire-once coalescing across a rebuild, CRUD, validation-at-save; no real timers |
| Enqueue gate | All sources × both validation points; timer rejection lands a `failed` row; chain rejection fails the producer ladder |
| Chain | Two-definition fixture pair (A's terminal `scriptTask` enqueues B; B declares `inputSchema`); dry-run rehearsal via `passthroughNodes` |
| Version resolution | Pin hit / pin missing / no-pin-latest, resolved at dequeue |
| Durability | Existing resume-suite pattern: enqueue, close, rebuild on the same dataDir; pending jobs dispatch, missed ticks coalesce |
| Profile/linter | `inputSchema` read, FF004 against schema properties, `setInputSchema` round-trip (DI untouched) |
| Web | Component tests for the enqueue form (SchemaForm prior art), job list, schedule form |

External behavior only — no queue-table internals, no module private state.

## 13. Risks and open points

- **Two recurrence models** (schedule vs in-flow loop) can confuse authoring; mitigated by the rule of thumb in the PRD (loop = flow control, schedule = pure cadence) surfacing in docs and the grill prompt.
- **Chain commands are shell + curl**: quoting mistakes are easy. The documented snippet is the mitigation; a bundled CLI helper stays a later option.
- **Direct-start semantics change** (409 → 202) touches every existing start caller; contained by updating the web form and tests in the same milestone.
- **Croner correctness at DST edges** is trusted, not tested here.
