# M1 Engine Spike / Walking Skeleton Implementation Plan

**Goal:** Proved `bpmn-engine` supports durable resume and timer persistence (PRD risk #1) via a walking skeleton: engine embedded, SQLite persistence, kill-and-resume, loop timers across restart. Go/no-go gate for the rest of Flow Fabric. **Verdict: GO.**

**Architecture:** pnpm monorepo; `packages/server` hosts a minimal `engine-host` module (`InstanceStore` for SQLite persistence, `EngineHost` wrapping `bpmn-engine`). State snapshot after every activity transition; boot-time `resumeAll()` recovers non-terminal instances. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M1, [design_flow-fabric.md](design_flow-fabric.md) §6.2.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm workspaces, `bpmn-engine` ^25, `better-sqlite3` ^12, vitest ^3, tsx ^4.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext`.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))`, never in the repo.
- Workflow fixtures use only elements from the Flow Fabric profile (design §4.1): script tasks, exclusive gateways, timer intermediate catch events, start/end events.
- `bpmn-engine` ships its own TypeScript types; do not install `@types/bpmn-engine` (doesn't exist). If `tsc` reports missing declarations, add a minimal `declare module 'bpmn-engine';` shim.
- Claude Agent SDK configuration comes from environment variables only (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`). M1 never calls the SDK — the scaffold just puts the convention in place for M2.
- Timer tests assert wall-clock windows with ±1.5 s slack; vitest `testTimeout: 20000`.

---

### Task 1: Monorepo scaffold

Scaffolded the pnpm monorepo with `packages/server`, `packages/shared`, and `packages/web` (placeholder). Root config established `tsconfig.base.json` with strict ESM/NodeNext, `.env.example` documenting Claude SDK vars, and `.gitignore` additions.

### Task 2: Prove bpmn-engine executes a profile-shaped fixture

Created `test/fixtures/basic.bpmn` (start → scriptTask → end) and confirmed bpmn-engine executes it, reports `activity.start`/`activity.end` transitions, and reaches `idle` state. Established the listener event names and script-task idiom (`this.environment.variables`, `next()`) used by all later fixtures.

### Task 3: SQLite persistence — InstanceStore + EngineHost

Implemented `InstanceStore` (`packages/server/src/engine-host/store.ts`) with WAL-mode SQLite, `instances` + `events` tables, and `EngineHost` (`packages/server/src/engine-host/engine-host.ts`) wrapping `bpmn-engine`. Key design: snapshot via queued async `getState()` on every `activity.start`/`.wait`/`.timer`/`.end`; `resumeAll()` recovers non-terminal instances on boot.

### Task 4: Durable resume — in-process stop/resume and SIGKILL crash

Go/no-go heart of the spike. Proved timers fire at their **originally scheduled** time after both in-process stop/resume and SIGKILL crash recovery. `spike-child.ts` script enables the cross-process kill test. Both assertions passed: resume leg duration matched remaining timer, not a full re-arm.

### Task 5: Loop timer across restart (rfp-daily shape)

Proved the rfp-daily pattern (duration timer inside a gateway loop) survives a restart mid-loop: exactly 3 `activity.end:work` events, no double execution. Also ran `probe-timecycle.ts` to confirm `timeCycle` (R3/PT2S) fires once and ignores the repeat count — not usable for recurrence.

### Task 6: Spike findings + go/no-go gate

Aggregated all test results and probe output into the findings summary below. Applied the `timeDuration`-only restriction to `design_flow-fabric.md` §4.1.

---

## Spike Findings

| | |
|---|---|
| Date | 2026-07-18 |
| bpmn-engine version | 25.0.1 |
| Verdict | GO |

### Questions and answers

| Question | Answer | Evidence |
|---|---|---|
| State serializes to JSON and recovers? | Yes. `getState()` returns a JSON-serializable snapshot; `new Engine().recover(state)` + `resume()` continues execution. | persistence.test.ts, resume.test.ts |
| Timer honors original schedule after in-process stop/resume? | Yes. Stopped ~3 s into a 6 s timer; after resume it fired at the original deadline (test wall-clock ~6 s total, resume leg ~3 s, within ±1.5 s slack). | resume.test.ts test 1 |
| Timer honors schedule after SIGKILL crash? | Yes. Child process killed mid-timer; parent recovered from the DB and the timer fired on the original schedule (resume leg ~3 s). | resume.test.ts test 2 |
| SQLite/WAL intact after SIGKILL? | Yes. The DB written by the killed child was readable by the parent; status was still `running` and `resumeAll()` picked it up. | resume.test.ts test 2 |
| Gateway loop + duration timer survives restart, no re-execution? | Yes. Restart during the second wait; exactly 3 `activity.end:work` events, no double execution after resume. | loop.test.ts event counts |
| timeCycle (R3/PT2S) supported on intermediate catch? | Partially: it fires once after one period (2 s) and the token moves on. No repetition; `R3` is ignored. Not usable for recurrence. | probe-timecycle.ts output, 2026-07-18 |
| State snapshot size for a small process | 4048 bytes | instances.engine_state for basic.bpmn |

### Additional observations

- Timer intermediate catch events never emit `activity.wait`. The arm signal is `activity.timer` (listener `api.id` = element id) and the fire signal is `activity.timeout`. `EngineHost` snapshots on `activity.timer`; anything downstream that watches for waiting timers must use that event, not `activity.wait`.
- `engine.getState()` is async; concurrent snapshots must be serialized (EngineHost queues them) or writes can interleave.
- Gateway conditions in `language="javascript"` with `next(null, bool)` work as expected, including after a resume.

### Workarounds required

None. The persistence, resume, and timer-schedule behavior needed for FR-9 works out of the box.

### Profile amendments

Restrict FR-6 timers to `timeDuration` only. `timeCycle` fires once and ignores the repeat count, so recurrence must be modeled as a gateway loop around a duration timer (the shape rfp-daily already uses). Applied to design_flow-fabric.md §4.1.

### Gate decision

GO — proceed to the M2 plan (runners + failure ladder). No re-plan needed; carry the `activity.timer` event naming and the timeDuration-only restriction into M2's engine-host work.

## Critical Files

| Path | Role |
|---|---|
| `packages/server/src/engine-host/engine-host.ts` | EngineHost: wraps bpmn-engine, snapshot queue, resumeAll() |
| `packages/server/src/engine-host/store.ts` | InstanceStore: SQLite WAL, instances + events tables |
| `packages/server/test/fixtures/basic.bpmn` | Minimal fixture: start → scriptTask → end |
| `packages/server/test/fixtures/timer.bpmn` | 6 s timer fixture for resume tests |
| `packages/server/test/fixtures/loop.bpmn` | Gateway loop with 2 s timer (rfp-daily shape) |
| `packages/server/scripts/spike-child.ts` | CLI for cross-process SIGKILL test |
| `packages/server/scripts/probe-timecycle.ts` | Manual timeCycle probe |

## Changelog

- 2026-07-18 — **Compacted post-implementation.** Removed step-by-step tasks, file-by-file diffs, code snippets, and verification commands now that the spike has shipped. Merged findings from `findings_m1-spike.md`. Preserved Goal, Global Constraints, task summaries, spike findings, and critical files. Original plan recoverable via git history.
