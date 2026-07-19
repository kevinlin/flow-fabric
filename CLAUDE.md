# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flow Fabric is a local, web-based control plane for AI Developer Workflows (ADWs). Users model workflows as BPMN 2.0 diagrams; the platform executes them end-to-end against a target workspace (a folder), coordinating three actors: **agents** (Claude), **humans**, and **deterministic code**. The BPMN file is the source of truth for flow control, task contracts, I/O, and error handling. The engine owns the tokens and gateway decisions — agents never decide what runs next (the Kubernetes control-plane analogy: Flow Fabric owns orchestration state; the workspace is the workload).

## Current state — read this first

**M1–M4 are built; M5 is not.** The six web pages exist and run against the live daemon.

Built (`packages/server/src/`, all exercised through tests — [index.ts](packages/server/src/index.ts) is the public surface):
- `engine-host/` — `EngineHost` + `InstanceStore` (M1), plus `dispatch` (runner wiring into bpmn-engine) and `failure` (the ladder) from M2. Instance status gained `terminated` (M3) for terminate end events.
- `runners/` — `TaskRunner` interface, `StubRunner` (dry-run), `CodeRunner`, `AgentRunner` (Claude Agent SDK), Ajv `validateOutput`.
- `profile/read.ts` — reads task contracts, `instanceInputs`, and terminate-end ids out of a BPMN's `flowfabric` extension elements into a `ProcessProfile`.
- `definitions/` — `DefinitionStore`: immutable BPMN versions + deployable flag (M3).
- `linter/` — pure `lint(xml)` deployability gate, rules FF001–FF006 (M3, design §4.3).
- `patch-ops/` — `applyPatchOps`: typed moddle edits that never touch DI (M3, design §7.3).
- `grill/` — `GrillHost`/`GrillSession`: Claude Agent SDK chat whose only mutating tool is `propose_patch_ops`, with a re-lint feedback loop (M3).
- `inbox/`, `notify/` — user-task inbox + macOS notifier (deep-links to the inbox, `DEFAULT_INBOX_LINK`). `logs/ring.ts` — bounded pino ring buffer (M4). `api/server.ts` — Fastify REST + SSE, and serves the built SPA from `packages/web/dist` at `/` (API routes win; SPA fallback for history routes). `daemon.ts` — the process entrypoint.
- M4 server additions: instance→definition linkage (`definition_id`/`version_no` on `instances`, migration-guarded), `metricsForDefinition` + `GET /api/metrics/definitions/:id` (FR-23), armed-timer registry + `GET /api/scheduler` (FR-25), `GET /api/logs` (FR-25), `GET /api/definitions/:id/versions`, `GET /api/grill/sessions/:id`, `GET /api/task-executions/:id/transcript`, and the SSE vocabulary `usertask.created/submitted` + `incident.resolved`.
- `packages/web/` — React 19 + Vite 7 SPA (M4): hash-routed six pages (Definitions, Refine, Instances+detail, Inbox, Dashboards, System). `bpmn-js` NavigatedViewer render + token overlay, native `EventSource` SSE, a hand-rolled `SchemaForm` (flat JSON-Schema + raw-JSON escape hatch), typed API client over `@flowfabric/shared` DTOs. Pure libs (`node-status`, `instance-view`, `chat`, `logs`) are unit-tested; components via `@testing-library/react` + jsdom.
- `packages/shared/src/` — profile types, moddle descriptor (`flowfabricModdle`), lint rule ids/types, and `api/types.ts` DTOs (M4) consumed by web and pinned by the server.

Not built (still spec — don't assume they exist): OTel traces/metrics + soak (M5).

**Daemon entrypoint:** `pnpm --filter @flowfabric/server dev` boots [daemon.ts](packages/server/src/daemon.ts) — wires store + host + inbox + notifier + definitions + grill + API, calls `resumeAll()`, and listens on `FF_PORT` (default 4400), data dir `FF_DATA_DIR` (default `~/.flow-fabric`). M1's go/no-go gate on `bpmn-engine` passed (verdict GO).

## Commands

Node ≥ 22, pnpm workspaces (ESM throughout).

```bash
pnpm install                              # native better-sqlite3 compiles here
pnpm build                                # pnpm -r build (tsc per package)
pnpm test                                 # pnpm -r test (vitest per package)

pnpm --filter @flowfabric/server test     # one package
pnpm --filter @flowfabric/server test resume   # one test file by name substring (vitest filter)

# run a spike probe script (tsx, not a unit test)
cd packages/server && node --import tsx scripts/probe-timecycle.ts   # also: probe-dispatch.ts
```

Tests: server in `packages/server/test/*.test.ts` (one file per module — engine, runners, dispatch, failure ladder, linter, patch-ops, grill, metrics/scheduler/logs, SSE vocab); web pure-lib + `@testing-library/react` component tests under `packages/web/src`; shared types in `packages/shared`. Fixtures in `packages/server/test/fixtures/*.bpmn`. `AgentRunner` tests inject a mock `AgentQueryFn` — no live SDK calls.

## Architecture

Target shape (design): modular monolith, one Node daemon hosting the BPMN engine, scheduler, REST + SSE API, and serving the built SPA. Module boundaries are internal packages, not processes.

Monorepo (`packages/*`):
- `shared/` — profile types + moddle descriptor + lint rule IDs + API DTOs (built)
- `server/` — the daemon and all backend modules
- `web/` — React + Vite SPA (built, M4). `pnpm --filter @flowfabric/web dev` runs Vite on :5173 proxying `/api` → :4400; `pnpm --filter @flowfabric/web build` emits `dist/` that the daemon serves. Web tsconfig is `Bundler` resolution (extensionless imports) — the `.js`-extension NodeNext rule does not apply here.

Control-plane state lives in `~/.flow-fabric/` (SQLite + agent transcripts + definition versions). The workspace is pure workload — the platform never writes its own state there.

### engine-host — durable state (FR-9)

`EngineHost` ([packages/server/src/engine-host/engine-host.ts](packages/server/src/engine-host/engine-host.ts)) wraps `bpmn-engine`; `InstanceStore` ([packages/server/src/engine-host/store.ts](packages/server/src/engine-host/store.ts)) is SQLite persistence (WAL) plus an append-only `events` log, and now also holds `user_tasks`, `task_executions`, and `incidents`. A partial unique index (`one_active_per_workspace`) enforces one live instance per workspace (FR-10) — a second `start()` on the same workspace throws `UNIQUE constraint failed`, which the API maps to 409.

Durability is the core bet (FR-9). The mechanism:
- On every activity transition (`activity.start` / `activity.end` / `activity.wait` / `activity.timer`), `EngineHost` appends an event and re-serializes `engine.getState()` into `instances.engine_state`.
- On boot, `resumeAll()` loads non-terminal instances, rebuilds each engine with `new Engine().recover(state)`, and resumes. In-flight timers fire at their **originally scheduled** time, not reset — this is what makes 24/7 operation and multi-day timer loops safe.

### How a task actually runs (M2 — dispatch + failure)

bpmn-engine doesn't know about agents or contracts. `createDispatch` ([dispatch.ts](packages/server/src/engine-host/dispatch.ts)) hooks the engine at two seams (found in the M2 dispatch spike):
- **`extensions`** — intercepts `ServiceTask` execution, swapping in a `Service` factory that calls the agent runner and merges its output into `activity.environment.variables`.
- **`scripts`** — `ScriptTask`s with a code contract go to the code runner; inline `<script>` bodies and JS gateway `conditionExpression`s compile to a `Function` with bpmn-engine's default `this`=scope / `next(err, result)` semantics.

Every task goes through a `RunTaskFn` seam:
- `makeSingleAttemptRunTask` — one attempt, timeout via `AbortController` (`contract.timeoutSeconds`), records one `task_executions` row per attempt (inputs/output/status/timing/token usage/cost/transcript path — FR-14).
- `makeLadderRunTask` ([failure.ts](packages/server/src/engine-host/failure.ts)) wraps it with the **failure ladder** (FR-18), and `EngineHost` always installs the ladder — including the dry-run stub path, so incidents work in dry runs. Rungs: retry (`contract.retries + 1` attempts) → **modeled error boundary** (if the node has one, reject and let the engine route the token) → **incident** (persist row, set status `incident`, notify, and **pause the token by leaving the runTask promise pending**). The pending resolver lives in the `holds` map keyed `${instanceId}:${nodeId}`; `resolveIncident(id, 'retry'|'skip'|'abort', output?)` releases or aborts it. On restart, an open incident re-holds without re-running or re-notifying.

**User tasks (inbox):** a `userTask` emits `activity.wait` → `onUserTaskWait` → `Inbox` ([inbox.ts](packages/server/src/inbox/inbox.ts)) creates a `user_tasks` row and notifies. `submit` validates vars against the contract's `formSchema` (FR-13), then `EngineHost.signal()` merges vars into process variables and releases the token. Idempotent across resumes (dedupes on a pending row).

**API surface** ([api/server.ts](packages/server/src/api/server.ts), Fastify): `POST /api/instances` (start; 409 on workspace lock; records definition linkage), `GET /api/instances[/:id]` (instance + timeline + events), `POST /api/instances/:id/abort`, `GET /api/inbox`, `POST /api/user-tasks/:id/submit`, `POST /api/incidents/:id/resolve`, `GET /api/events` (SSE, fanned out from `InstanceStore.onEvent`), plus M4 reads: `GET /api/metrics/definitions/:id`, `GET /api/scheduler`, `GET /api/logs`, `GET /api/definitions/:id/versions`, `GET /api/grill/sessions/:id`, `GET /api/task-executions/:id/transcript`. Non-`/api` GETs serve the built SPA (`@fastify/static`, `webRoot` = `packages/web/dist`).

## bpmn-engine gotchas

Load-bearing and easy to get wrong. Full rationale + probe evidence live in the plan files — load [plan_m1-engine-spike.md § Spike Findings](docs/specs/plan_m1-engine-spike.md#spike-findings) (engine) and [plan_m2-runners-failure-ladder.md](docs/specs/plan_m2-runners-failure-ladder.md) (dispatch seams) when working on those areas. The traps:

- **`getState()` is async.** Serialize concurrent snapshots through a queue (as `EngineHost` does) or writes interleave and corrupt state.
- **Timer catch events never emit `activity.wait`.** Arm on `activity.timer`, fire on `activity.timeout`. Watch `activity.timer`, not `activity.wait`.
- **`timeCycle` is not usable for recurrence.** Fires once, ignores the repeat count. Profile is `timeDuration`-only; model recurrence as a gateway loop around a duration timer (the `rfp-daily` shape).
- **Gateway conditions** use `language="javascript"` with `next(null, <bool>)` over process variables; they survive resume.

## Flow Fabric BPMN profile (design §4)

- Actor mapping via standard BPMN task types (so any BPMN editor still reads the files): `userTask` → human, `scriptTask` → deterministic code, `serviceTask` → agent (Claude). Lanes are documentation only; they never affect execution.
- Task contracts live in `bpmn:extensionElements` under namespace `http://flowfabric.dev/schema/1.0` (prompt, tools, boundaries, inputs, output JSON Schema, retries).
- Supported elements: start/end events (incl. terminate), exclusive gateways, the three task types, timer intermediate catch events (**duration only**), error boundary events. The linter rejects everything else.

## Conventions

- Conventional commits: `feat:`, `test:`, `chore:`, `docs:`.
- ESM everywhere (`"type": "module"`), TS `strict`, `NodeNext` resolution. **Import local modules with the `.js` extension** in TS source (`./store.js`), per NodeNext ESM.
- TDD: the M1 plan is failing-test-first, task by task. Follow that rhythm.
- Test databases go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- `bpmn-engine` ships its own types; do not install `@types/bpmn-engine` (it doesn't exist).

## Agent runtime config

`AgentRunner` ([runners/agent.ts](packages/server/src/runners/agent.ts)) calls `query()` from `@anthropic-ai/claude-agent-sdk` headless: `cwd`=workspace, `allowedTools` from the contract, `permissionMode: 'bypassPermissions'`, `settingSources: []`. It appends the message stream to a per-attempt transcript (`<dataDir>/transcripts/<instanceId>/<nodeId>.<attempt>.jsonl`), extracts the trailing JSON object, and does one in-session resume-and-retry if the first reply isn't valid JSON. The SDK reads env vars only: `ANTHROPIC_API_KEY`, plus optional `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` for Claude-compatible endpoints (e.g. DeepSeek's Anthropic API), loaded from a git-ignored `.env` (see [.env.example](.env.example)). Model/endpoint are deployment config, not per-task contract fields. Dry runs use `StubRunner` and never touch the SDK; the runner is injected via `EngineHostOptions.runners`, so tests pass a mock.

## Docs map

[docs/specs/index.md](docs/specs/index.md) is the canonical navigation map — start there. Read the relevant spec before extending: M1–M4 are built, only M5 (OTel + soak) is still spec. Milestone-specific findings and gotchas live in the plan files; load them on demand.

- [docs/product/prd_flow-fabric.md](docs/product/prd_flow-fabric.md) — PRD: problem, goals (G1–G3), requirements (FR-1..25), v1 scope
- [docs/specs/design_flow-fabric.md](docs/specs/design_flow-fabric.md) — approved design: modules, profile, data model, execution semantics, failure ladder
- [docs/specs/impl_flow-fabric.md](docs/specs/impl_flow-fabric.md) — five milestones (M1–M5), each with a verification gate
- Plans (all done, compacted post-ship): [M1 engine spike](docs/specs/plan_m1-engine-spike.md) (+ spike findings, GO verdict), [M2 runners + failure ladder](docs/specs/plan_m2-runners-failure-ladder.md) (+ dispatch spike findings), [M3 intake](docs/specs/plan_m3-intake.md), [M4 web UI](docs/specs/plan_m4-web-ui.md) (+ build findings for M5)

`Input/` and `Output/` are git-ignored. The two real BPMN files (`Input/bpmn/rfp-daily-routine.bpmn`, the flagship Signavio export, and `interview-process.bpmn`, the intake generality case) live locally but aren't tracked.
