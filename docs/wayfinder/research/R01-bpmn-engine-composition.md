---
labels: [wayfinder:research]
title: "R01 — bpmn-engine composition and multi-instance under Flow Fabric durability"
ticket: R01
date: 2026-07-22
---

# R01 — bpmn-engine composition & multi-instance

Resolves Wayfinder ticket [R01](../tickets/R01-research-bpmn-engine-composition.md); feeds the composition-mechanism decision in [003](../tickets/003-composition-mechanism.md).

**Versions probed:** `bpmn-engine` 25.0.1, `bpmn-elements` 17.3.0 (the versions installed in this repo).

## Verdict

The engine supports call activities, embedded subprocesses, and multi-instance markers, and all three survive `getState()` / `recover()` with **timers honoring their original deadline across the composition boundary** — the load-bearing property is intact. Proven by probe (`packages/server/scripts/probe-composition.ts`): a duration timer inside a subProcess, stopped at +3s of a 6s wait, recovered into a fresh engine, fired at the original 6s deadline (total wall-clock 6017ms, not 9000ms).

The hard constraint is scope: a `callActivity` resolves its `calledElement` **only against `<process>` elements in the same `<definitions>` document**. It cannot reach a separate BPMN file/definition. Composing a genuinely separate definition means either merging it into one source, or orchestrating it at the host level (start a second instance), where you build the durability glue and hit the workspace lock.

Independent of engine capability, Flow Fabric's current profile layers — linter, `readProfile`, dispatch — are built for one flat process and **reject or silently miss** every composition construct today. Adopting any of them is a profile-expansion project, not a config flip.

## Capability table

| Feature | Engine supports? | API / config | Durability-safe? |
|---|---|---|---|
| `bpmn:callActivity` (same-definition) | Yes | `calledElement="<processId>"` where the id is another `<process>` in the same source. Engine auto-spawns and runs the called process (`DefinitionExecution._onCallActivity` → `Context.getNewProcessById`). No host code required. | Yes — recover guarded against double-spawn (`content.isRecovered` check); probe 1 + durability probe. |
| `bpmn:callActivity` (cross-definition / separate file) | **No** (not natively) | `getNewProcessById` resolves only within the calling definition's context; an unknown id makes the call a silent no-op — the token waits forever. | N/A (unsupported natively) |
| `bpmn:subProcess` (embedded / expanded) | Yes | Inline `<subProcess>` with its own start/flow/end. Runs as a nested `ProcessExecution`; nested `activity.*` events bubble to the top-level listener. | Yes — nested state serializes into the one engine snapshot; probe 2 + durability probe (timer inside subProcess resumed on original schedule). |
| `bpmn:subProcess` (event / transaction) | Partial / untested here | `triggeredByEvent` subprocess exists in `bpmn-elements`; not probed, not in Flow Fabric's needs. | Unverified |
| Multi-instance marker (`multiInstanceLoopCharacteristics`) | Yes | On any task/subProcess. `isSequential="true|false"`. Iteration count from `loopCardinality` (standard), a collection, or a completion condition. | Sequential loop uses redelivered `execute.iteration.next` with a persisted index — resumes mid-loop. (Consistent with M1's proven gateway-loop resume; parallel-branch resume not separately probed.) |
| Multi-instance **collection** binding | Yes, but not via standard attr | `bpmn-elements` reads `behaviour.collection`; standard `<loopDataInputRef>` is **not** mapped by the default moddle. Works via an extension attribute (`js:collection`, `camunda:collection`) or via `loopCardinality`. Probe with `loopDataInputRef` threw "cardinality, collection, or condition is required"; `loopCardinality` ran clean. | Same as marker |
| Sub-instance of a **second definition** from inside a task | Host pattern only | No engine primitive. Options below. | Depends on the pattern chosen |
| `engine.addSource()` (multiple definitions in one engine) | Yes | Adds another top-level definition; both run as independent top-level processes. **Does not** let a callActivity in definition A reach a process in definition B — each callActivity is scoped to its own definition context. | State covers all definitions in the engine, but this is co-execution, not composition |
| `getState()` / `recover()` round-trip | Yes | `await engine.getState()` (async) → persist JSON → `new Engine().recover(state)` → `engine.resume()`. | This is the whole bet; holds across composition boundaries per probes |
| Originally-scheduled timers across a composition boundary | Yes | `TimerEventDefinition` persists `startedAt`/`expireAt`; on resume it recomputes `timeout = expireAt − now`, so the deadline is absolute, not re-armed. | Yes — durability probe: 6s subProcess timer fired 6017ms after original start |

## Question-by-question

### Q1 — callActivity, subProcess, multi-instance: supported? API?

**callActivity — yes, same-definition only.** `CallActivityBehaviour.execute` resolves `this.environment.resolveExpression(this.calledElement)` and publishes an `activity.call` event. The engine's `DefinitionExecution` subscribes to `activity.call` and, in `_onCallActivity`, calls `this.context.getNewProcessById(calledElement)`, activates that process, and runs it as a child (`bpmn-elements/dist/definition/DefinitionExecution.js:569`). `getNewProcessById` looks the id up in `definitionContext` and returns `null` if absent (`Context.js:112`). So the called element must be another `<process>` in the same `<definitions>` document. No host wiring needed for the same-definition case — this is fully automatic, unlike what the CallActivity element source alone (which only emits `activity.call` and waits) suggests. Probe 1 confirmed: parent → `activity.call` → child process ran its script task → parent continued to its end event.

**subProcess — yes.** `SubProcessBehaviour` builds a nested `ProcessExecution` over the subprocess's own flow elements (`bpmn-elements/dist/tasks/SubProcess.js`). Nested `activity.start/end/timer/...` events surface on the same top-level engine listener (probe 2 showed `ss`/`st`/`se` inside `sub`). This matters for Flow Fabric because the EngineHost listener keys on `api.id`, so nested nodes are observed as long as ids are unique.

**Multi-instance — yes, marker parsed and executed** (`LoopCharacteristics.js`, `StandardLoopCharacteristics.js`). `isSequential`, `loopCardinality`, `collection`, and completion/start conditions are all read. The catch: the **collection** is read from `behaviour.collection`, which the default bpmn-moddle does not populate from standard `<loopDataInputRef>`. The documented working form uses an extension-namespace attribute (`js:collection="${environment.variables.items}"`) — see bpmn-engine `docs/Examples.md` "Task loop over collection". Probe 3 confirmed `loopCardinality` runs; `loopDataInputRef` fails.

### Q2 — start / embed a sub-instance of a second definition from inside a running instance

No engine primitive spawns another *definition* from inside a task. Three patterns, in order of durability safety:

1. **Merge into one source (recommended).** Put the second workflow's `<process>` into the caller's `<definitions>` as an additional (non-executable) process and invoke it with `callActivity calledElement="thatProcessId"`. Everything stays in one engine and one state blob, so it inherits the exact durability guarantees M1 proved. This is the only composition path that is durable "for free."
2. **Host-level orchestration.** Have the EngineHost listen for `activity.call` (or intercept a service task) and start a *separate* instance/engine for the second definition, then signal the caller's callActivity back on completion (`api.signal(output)` / route an error). You get independent versioning and separate `instances` rows, but you build the parent↔child correlation, the resume re-linking, and the completion handoff yourself — none of it comes from the engine. Two moving durable states instead of one.
3. **`engine.addSource()`.** Runs multiple definitions in one engine as independent top-level processes (`docs/API.md` "Add BPMN Definition Source"). This is co-execution, not parent/child composition — a callActivity still can't cross the definition boundary — so it does not answer the sub-instance need on its own.

A service/script task *could* call back into the EngineHost to `start()` another instance (pattern 2 without callActivity), but that fires a fresh top-level instance with its own lifecycle; the parent task would have to block and poll, and there is no engine-level join. Not recommended as the primary mechanism.

### Q3 — durable resume + original timer schedule across the boundary

Confirmed by probe and by source.

- **Round-trip:** `getState()` is async and returns JSON-serializable state covering nested processes and called processes; `recover(state) + resume()` continues them. The durability probe serialized a mid-subProcess state (13548 bytes) and resumed it in a fresh engine to completion.
- **Timers:** `TimerEventDefinition` stores `startedAt` and derives `timeout = expireAt − now` on (re)start (`bpmn-elements/dist/eventDefinitions/TimerEventDefinition.js:62,251-262`). A timer inside a subProcess therefore fires at its absolute original deadline after recover — the probe measured 6017ms total for a 6s timer stopped and resumed at the 3s mark, matching M1's top-level finding.
- **Recover idempotency:** `_onCallActivity` skips re-spawning a called process that already exists under its recovered execution id (`content.isRecovered` guard), and sequential multi-instance carries a persisted iteration index on `execute.iteration.next` redelivery — the same "no double execution after resume" property M1 proved for gateway loops.

## Recommended mechanism for a durable control plane

**Primary: same-source `callActivity` + embedded `subProcess`.** For a control plane whose whole bet is durable 24/7 resume, keep composition inside one engine and one state blob. `callActivity` gives a named, reusable sub-workflow (a "library call"); `subProcess` gives inline grouping (scoped error boundaries, a multi-instance container). Both are engine-owned control flow — the agent still never decides what runs next — and both round-trip through `getState`/`recover` with original timer schedules. This defends the core bet with zero new resume machinery.

**If separate, independently-versioned definitions are a hard requirement:** host-level orchestration (pattern 2) is the only option, and it is a real build: parent/child correlation, resume re-linking, completion/error handoff, plus a decision about the workspace lock (see below). Treat it as a milestone, not a profile tweak. Prefer deferring it unless the "library of separately-versioned workflows" goal in the map genuinely needs cross-file calls that merging can't satisfy.

## Hard limitations & gotchas

- **callActivity is same-definition only.** Cross-file `calledElement` silently no-ops (`getNewProcessById` → `null`) and the token waits forever — no error is raised. Any adoption must validate that `calledElement` resolves to a process id present in the same source.
- **Flow Fabric's linter rejects both today.** `packages/server/src/linter/lint.ts` allows only a fixed element set; `bpmn:CallActivity` and `bpmn:SubProcess` fall through to the `default` branch and are flagged as unsupported (FF001). They also aren't in `PASSIVE_TYPES`. Supporting composition means new lint rules (allow callActivity with an in-source calledElement; recurse into subProcess children; reject cross-file calls).
- **`readProfile` does not recurse into subprocesses.** `packages/server/src/profile/read.ts` iterates only each process's top-level `flowElements`. Contracts on tasks *inside* a `<subProcess>` are never discovered, so dispatch would find no contract — an agent serviceTask would have no `Service`, a userTask would create no inbox row, and the token would stall. It **does** iterate all top-level `<process>` elements, so a same-source called process's top-level task contracts are picked up. Fix: recurse into `subProcess.flowElements`.
- **Dispatch keys on node id globally.** `createDispatch` builds `extensions`/`scripts` keyed by `activity.id` and looks contracts up by node id. Across multiple processes/subprocesses in one source, **node ids must be globally unique** or contracts and script registrations collide. Add a uniqueness lint rule before allowing composition.
- **Multi-instance collection needs an extension attribute.** Standard `<loopDataInputRef>` is not wired; bind the collection via a `flowfabric:` moddle attribute (or restrict multi-instance to `loopCardinality`). Without this, a modeled collection loop throws at runtime.
- **Workspace lock blocks host-level sibling instances.** The `one_active_per_workspace` partial unique index (`store.ts`, FR-10) permits one live instance per workspace. A host-orchestrated child instance targeting the same workspace as its parent would hit `UNIQUE constraint failed` → 409. Cross-definition composition on a shared workspace needs this rule rethought (e.g. parent/child share a lock, or children run in sub-workspaces).
- **`timeCycle` still unusable** (M1 finding, unchanged): recurrence must be a gateway loop around a `timeDuration` timer — a multi-instance loop does not change this.

## Evidence & sources

- Probe: `packages/server/scripts/probe-composition.ts` (this ticket). Four cases — same-source callActivity, embedded subProcess, multi-instance (`loopCardinality`), and durable resume of a timer inside a subProcess — all pass; the durability case measured 6017ms for a 6s timer stopped/resumed at 3s.
- `bpmn-elements` 17.3.0 source: `dist/tasks/CallActivity.js`, `dist/definition/DefinitionExecution.js` (`_onCallActivity`, lines ~569), `dist/definition/Context.js` (`getNewProcessById`, ~112), `dist/tasks/SubProcess.js`, `dist/tasks/LoopCharacteristics.js`, `dist/eventDefinitions/TimerEventDefinition.js` (`startedAt`/`expireAt`, lines 62 / 251-262).
- bpmn-engine docs (context7 `/paed01/bpmn-engine`): `docs/API.md` — `execute`, `getState`, `stop`, `recover`, `resume`, `addSource`; `docs/Examples.md` — "Task loop over collection" (multi-instance via `js:collection`); llms.txt — "Durable Execution: Stop, Persist, Recover, Resume".
- Flow Fabric code reviewed: `packages/server/src/engine-host/engine-host.ts` (snapshot on `activity.*`, `resumeAll`, timer registry), `store.ts` (`one_active_per_workspace`), `dispatch.ts` (node-id-keyed hooks), `profile/read.ts` (top-level-only contract scan), `linter/lint.ts` (allowed-element gate).
- Prior findings: [plan_m1-engine-spike.md](../../specs/plan_m1-engine-spike.md) §Spike Findings (getState/recover + original-schedule timers, timeCycle rejection), [plan_m2-runners-failure-ladder.md](../../specs/plan_m2-runners-failure-ladder.md) §Dispatch Spike (extensions/scripts seams, recover re-invokes in-flight service).
