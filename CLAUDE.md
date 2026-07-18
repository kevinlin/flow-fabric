# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Flow Fabric is a local, web-based control plane for AI Developer Workflows (ADWs). Users model workflows as BPMN 2.0 diagrams; the platform executes them end-to-end against a target workspace (a folder), coordinating three actors: **agents** (Claude), **humans**, and **deterministic code**. The BPMN file is the source of truth for flow control, task contracts, I/O, and error handling. The engine owns the tokens and gateway decisions — agents never decide what runs next (the Kubernetes control-plane analogy: Flow Fabric owns orchestration state; the workspace is the workload).

## Current state — read this first

The repo is at **M1 only** (engine spike / walking skeleton). The design describes a full system, but almost none of it is built yet.

- Real code that exists: `packages/server/src/engine-host/` (`EngineHost` + `InstanceStore`) and its tests. That's it.
- `packages/shared/src/index.ts` and `packages/web` are empty placeholders (`export {}` / echo scripts) until M2 and M4.
- Modules named in the design (`definitions`, `linter`, `patch-ops`, `grill`, `runners`, `failure`, `events`, `inbox`, `notify`, the REST/SSE API, the SPA) are **spec, not code**. Don't assume they exist.
- M1's go/no-go gate on `bpmn-engine` passed (verdict GO). M2 (runners + failure ladder) is the next milestone and does not have code yet.

## Commands

Node ≥ 22, pnpm workspaces (ESM throughout).

```bash
pnpm install                              # native better-sqlite3 compiles here
pnpm build                                # pnpm -r build (tsc per package)
pnpm test                                 # pnpm -r test (vitest per package)

pnpm --filter @flowfabric/server test     # one package
pnpm --filter @flowfabric/server test resume   # one test file by name substring (vitest filter)

# run a spike probe script (tsx, not a unit test)
cd packages/server && node --import tsx scripts/probe-timecycle.ts
```

Test files: `packages/server/test/{smoke,engine-basics,persistence,resume,loop}.test.ts`, fixtures in `test/fixtures/*.bpmn`.

## Architecture

Target shape (design): modular monolith, one Node daemon hosting the BPMN engine, scheduler, REST + SSE API, and serving the built SPA. Module boundaries are internal packages, not processes.

Monorepo (`packages/*`):
- `shared/` — profile types, moddle descriptor, lint rule IDs, event types (empty until M2)
- `server/` — the daemon and all backend modules
- `web/` — React + Vite SPA (placeholder until M4)

Control-plane state lives in `~/.flow-fabric/` (SQLite + agent transcripts + definition versions). The workspace is pure workload — the platform never writes its own state there.

### engine-host (the only built module)

`EngineHost` ([packages/server/src/engine-host/engine-host.ts](packages/server/src/engine-host/engine-host.ts)) wraps `bpmn-engine`; `InstanceStore` ([packages/server/src/engine-host/store.ts](packages/server/src/engine-host/store.ts)) is SQLite persistence (WAL) plus an append-only `events` log.

Durability is the core bet (FR-9). The mechanism:
- On every activity transition (`activity.start` / `activity.end` / `activity.wait` / `activity.timer`), `EngineHost` appends an event and re-serializes `engine.getState()` into `instances.engine_state`.
- On boot, `resumeAll()` loads non-terminal instances, rebuilds each engine with `new Engine().recover(state)`, and resumes. In-flight timers fire at their **originally scheduled** time, not reset — this is what makes 24/7 operation and multi-day timer loops safe.

## bpmn-engine gotchas (from the M1 spike — see [findings_m1-spike.md](docs/specs/findings_m1-spike.md))

These are load-bearing and easy to get wrong:

- **`getState()` is async.** Concurrent snapshots interleave and corrupt state. `EngineHost` serializes them through a promise queue — preserve that pattern.
- **Timer intermediate catch events never emit `activity.wait`.** Arm signal is `activity.timer`, fire signal is `activity.timeout`. Anything watching for waiting timers must key on `activity.timer`, not `activity.wait`.
- **`timeCycle` (e.g. `R3/PT2S`) is not usable for recurrence.** bpmn-engine fires it once and ignores the repeat count. The profile is restricted to `timeDuration` timers only; model recurrence as a gateway loop around a duration timer (the shape `rfp-daily` uses).
- **Gateway conditions** use `language="javascript"` with `next(null, <bool>)` over process variables, e.g. `next(null, this.environment.variables.count < 3)`. These survive resume.

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

The Claude Agent SDK (M2 onward) is configured by env vars only: `ANTHROPIC_API_KEY`, plus optional `ANTHROPIC_BASE_URL` and `ANTHROPIC_MODEL` for Claude-compatible endpoints (e.g. DeepSeek's Anthropic API). The daemon loads them from a git-ignored `.env`; see [.env.example](.env.example). M1 never calls the SDK. Model/endpoint are deployment config, not per-task contract fields.

## Docs map

Read the spec before extending anything — most of the system is designed but unbuilt.

- [docs/product/prd_flow-fabric.md](docs/product/prd_flow-fabric.md) — PRD: problem, goals (G1–G3), requirements (FR-1..25), v1 scope
- [docs/specs/design_flow-fabric.md](docs/specs/design_flow-fabric.md) — approved design: modules, profile, data model, execution semantics, failure ladder
- [docs/specs/impl_flow-fabric.md](docs/specs/impl_flow-fabric.md) — five milestones (M1–M5), each with a verification gate
- [docs/specs/plan_m1-engine-spike.md](docs/specs/plan_m1-engine-spike.md) — M1 task-by-task plan (done)
- [docs/specs/findings_m1-spike.md](docs/specs/findings_m1-spike.md) — spike findings + GO verdict

`Input/` and `Output/` are git-ignored. The two real BPMN files (`Input/bpmn/rfp-daily-routine.bpmn`, the flagship Signavio export, and `interview-process.bpmn`, the intake generality case) live locally but aren't tracked.
