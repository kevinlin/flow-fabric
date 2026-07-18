# M2 Runners + Failure Ladder Implementation Plan

**Goal:** The three actors (agent, code, user) plus a stub runner execute real task contracts inside `bpmn-engine`, failures escalate per FR-18 (retry → error boundary → incident), and a minimal REST + SSE API exposes instances, the inbox, and the timeline.

**Architecture:** `packages/shared` gains the `flowfabric` profile (contract types + moddle descriptor). `packages/server` gains a contract reader, a `TaskRunner` interface with stub/code/agent implementations, and an extended `EngineHost` that intercepts serviceTask/scriptTask execution via bpmn-engine `extensions`/`scripts` hooks and userTask waits via `activity.wait` + `execution.signal`. The M1 durability mechanism (snapshot on every transition, `resumeAll()` on boot) is preserved and extended. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M2, [design_flow-fabric.md](design_flow-fabric.md) §3, §4, §6.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), pnpm workspaces, `bpmn-engine` ^25, `bpmn-moddle` ^10, `better-sqlite3` ^12, `ajv` ^8, `fastify` ^5, `@anthropic-ai/claude-agent-sdk` (latest, 0.3.x at plan time), vitest ^3.

## Global Constraints

- Node ≥ 22, pnpm ≥ 9. All packages `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext`. Import local modules with the `.js` extension in TS source.
- Conventional commits (`feat:`, `test:`, `chore:`, `docs:`).
- Test databases and workspaces go in `fs.mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'))` — never in the repo.
- `flowfabric` namespace is exactly `http://flowfabric.dev/schema/1.0` (design §4.2).
- Timers are `timeDuration` only (M1 finding). Timer arm signal is `activity.timer`, **not** `activity.wait` — `activity.wait` fires only for user tasks. Gateway conditions use `language="javascript"` with `next(null, <bool>)`.
- `engine.getState()` is async — every new snapshot call goes through the existing promise queue in `EngineHost.run()`; never call it concurrently.
- `bpmn-engine` ships its own types; do not install `@types/bpmn-engine`. Where its types are too loose for the `extensions`/`scripts` hooks, use narrow local interfaces and `as unknown as` at the engine boundary — do not `any`-cannon whole files.
- The Claude Agent SDK is configured by env only (`ANTHROPIC_API_KEY`, optional `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` from `.env`). No per-task model/endpoint fields.
- Vitest `testTimeout: 20000` (already configured). Timer fixtures use 2–6 s durations.
- M1 files (`store.ts`, `engine-host.ts`, existing tests) keep working — `pnpm test` stays green after every task. Extend, don't rewrite: existing public signatures may gain optional parameters but must not break existing callers.

## Task overview and dependencies

1. Shared profile: contract types + moddle descriptor (impl M2.1)
2. Server contract reader + profile fixture
3. Dispatch spike: probe bpmn-engine interception hooks (de-risks 5, 8, 9)
4. `TaskRunner` interface + stub runner (impl M2.2)
5. EngineHost dispatch integration + dry-run e2e (impl M2.2 verify)
6. Code runner (impl M2.3)
7. Agent runner (impl M2.4)
8. User task service + notifier (impl M2.5)
9. Failure ladder: retries → boundary → incident (impl M2.6)
10. `task_executions` recording + timeline (impl M2.8)
11. REST API + SSE (impl M2.7)

Tasks 6 and 7 are independent of each other and of 8; both depend on 4–5. Task 9 depends on 5–6. Tasks 10–11 depend on everything before them.

---

### Task 1: Shared profile — contract types + moddle descriptor

Defined the `flowfabric` BPMN profile types (`AgentTaskContract`, `CodeTaskContract`, `UserTaskContract`) and the `bpmn-moddle` descriptor that parses extension elements from BPMN XML. Established the `contracts.bpmn` fixture with one task of each actor type, reused by Tasks 2 and 5. Round-trip test confirms parse → serialize → re-parse preserves all contract data.

**Key types:** `TaskContract` (discriminated union), `flowfabricModdle` (moddle descriptor object), `FLOWFABRIC_NS`. Body-text children (`prompt`, `outputSchema`, …) use moddle `isBody` string properties. `tagAlias: 'lowerCase'` maps type names to XML tags.

---

### Task 2: Server contract reader

Implemented `readProfile(source)` that parses BPMN XML via `bpmn-moddle` with the `flowfabric` descriptor and returns a `ProcessProfile` containing a contract map and error boundary host set.

**Key interface:** `ProcessProfile { contracts: Map<nodeId, TaskContract>; errorBoundaryHosts: Set<nodeId> }`.

---

### Task 3: Dispatch spike — probe bpmn-engine interception hooks

Probed four mechanisms the runner integration depends on, via `packages/server/scripts/probe-dispatch.ts`. All four answered positively, de-risking Tasks 5, 8, 9.

#### Dispatch Spike Findings

| | |
|---|---|
| Date | 2026-07-18 |
| bpmn-engine version | 25.0.1 (bpmn-elements 17.3.0) |

| Question | Answer | Evidence |
|---|---|---|
| Service override via `extensions` works, async, boundary-routes errors? | **Yes.** `activity.behaviour.Service = factory` whose `execute(msg, callback)` is invoked; async `callback(null, out)` completes; `callback(err)` routes the token to the attached error boundary (no engine error). | q1 RESULT lines |
| Custom `scripts` runs script tasks **and** JS conditions? | **Yes.** `register({id,type,behaviour})` fires for every `bpmn:SequenceFlow` (condition in `behaviour.conditionExpression.body`) and every `bpmn:ScriptTask` (body in `behaviour.script`). `getScript(format, {id})` returns `{ execute(scope, callback) }`. Inline body compiled with `new Function('next', body)`, run `fn.call(scope, callback)`. | q2 RESULT line |
| userTask emits `activity.wait`; `execution.signal` resumes; signal vars land where? | **Emits `activity.wait`** and appears in `getPostponed()`. Resumes via `execution.signal({id})`. **Signal payload vars are NOT persisted.** Correct merge: write into the **running process** environment, then signal. | q3 RESULT lines |
| Recover with `{extensions}` re-invokes in-flight service `execute`? | **Yes.** After `getState()` mid-service-task, `new Engine().recover(state, {extensions,…})` + `resume()` re-invokes the service `execute` for the in-flight node. This is what re-establishes a held incident after restart (Task 9). | q4 RESULT line |

#### The load-bearing correction: two variable environments

bpmn-engine 25 serializes **two** distinct variable stores, and the plan's initially assumed read path was wrong:

- `state.definitions[0].environment.variables` — top-level definition/engine env. Holds only the initial `execute({variables})` seed. **Runtime task outputs never appear here.**
- `state.definitions[0].execution.processes[0].environment.variables` — **process execution env. This is the real "now" of process variables.** Holds the seed *and* every task output, *and* is what `resolveInputs` reads (an activity's `activity.environment` IS this process env).

**Canonical read path for process variables:**

```
state.definitions[0].execution.processes[0].environment.variables
```

#### Adjustments applied to downstream tasks

1. **`varsOf()` test helpers** read the process-execution env path, not the definition env.
2. **Service/script output write** is `Object.assign(activity.environment.variables, output)` — `activity.environment` is the process env, so outputs land in the canonical read path.
3. **`signal()` implementation** merges vars into `def.getRunningProcesses()[0].environment.variables`, then calls `execution.signal({id})`. Signal payload vars (`signal({id, ...vars})`) do not persist — there is exactly one correct merge path.
4. **Incident-after-restart** (Task 9) relies on q4 re-invocation — confirmed valid.

---

### Task 4: TaskRunner interface + stub runner

Defined the runner contract and implemented the stub and validation utilities.

**Key interfaces:**
- `TaskRunner { run(contract, inputs, ctx): Promise<RunResult> }` — the runner seam all actors implement.
- `RunContext { instanceId, nodeId, workspace, attempt, signal: AbortSignal, dataDir }` — per-invocation context.
- `RunResult { output, tokenUsage?, costUsd?, transcriptPath? }` — runner return type.
- `StubRunner` — derives schema-conforming fake output (zero-value per type) with per-node overrides keyed by nodeId.
- `validateOutput(schema, value)` — Ajv-based; throws `OutputValidationError` with `errorsText` on mismatch.

---

### Task 5: EngineHost dispatch integration + dry-run e2e

Wired runners into bpmn-engine via `extensions` (Service factory for agent/serviceTasks) and `scripts` (registry for code/scriptTasks + inline scripts + JS conditions). `createDispatch(deps)` produces both hooks. Extended `EngineHost` with runner options, dry-run mode, and user-task signal. `resumeAll()` became async to support `engineComponents()` (reads profile, builds dispatch hooks, passes moddleOptions to recover). M1 tests kept passing — the custom `scripts` hook is backward-compatible with inline scripts and JS conditions.

**Key interfaces:**
- `RunnerSet { agent: TaskRunner; code: TaskRunner }` — runner pair.
- `EngineHostOptions { runners?, dataDir?, onUserTaskWait? }` — host configuration.
- `DispatchDeps { instanceId, workspace, dataDir, profile, runners, runTask? }` — dispatch construction deps; `runTask` seam replaced by the failure ladder in Task 9.
- `RunTaskFn = (nodeId, contract, environment) => Promise<output>` — single-attempt or ladder-wrapped runner call.
- `EngineHost.signal(instanceId, nodeId, vars)` — resumes a waiting user task.
- `InstanceRow` gained `workspace: string`, `dryRun: boolean`, `stubOverrides: string | null`.

---

### Task 6: Code runner

Implemented `CodeRunner` — spawns `contract.command` with `cwd = ctx.workspace`, inputs as `FF_VAR_<NAME>` env vars and JSON on stdin, parses stdout as JSON output (FR-12). Kills the child when `ctx.signal` aborts (Node's `spawn({ signal })` propagation). Schema validation stays in dispatch, not the runner.

---

### Task 7: Agent runner (Claude Agent SDK)

Implemented `AgentRunner` — fresh headless Claude session per task via `query()` from `@anthropic-ai/claude-agent-sdk`. Builds prompt from contract (prompt + boundaries + serialized inputs + output-schema instruction). `extractJson()` parses bare JSON, fenced ```json blocks, and first-`{`-to-last-`}` substrings. One in-attempt retry by resuming the session (`resume: session_id`) if JSON extraction fails (design §6.1). JSONL transcript recording under `<dataDir>/transcripts/<instanceId>/<nodeId>.<attempt>.jsonl`. SDK options: `permissionMode: 'bypassPermissions'`, `allowDangerouslySkipPermissions: true`, `settingSources: []`, tool allowlist from contract. Mock-transport tests + conditional live smoke test (needs `ANTHROPIC_API_KEY`).

**Key types:** `AgentRunner`, `AgentQueryFn` (transport seam), `extractJson()`.

---

### Task 8: User task service + notifier

Implemented `Inbox` (creates pending row on `activity.wait`, validates formSchema on submit via `validateOutput`, resumes via `EngineHost.signal`) and `MacNotifier` (terminal-notifier → osascript fallback, never throws). `user_tasks` table added to store. `EngineHostOptions` gained `onUserTaskWait` callback. Idempotent across restarts: existing pending row prevents duplicate row creation and re-notification.

**Key interfaces:**
- `Inbox { handleWait(info), listPending(), submit(taskId, vars) }` — user task lifecycle.
- `Notifier { notify(title, body, link?) }` — notification seam.
- `UserTaskRow { id, instanceId, nodeId, formSchema, status, submittedVars }`.
- `UserTaskWaitInfo { instanceId, nodeId, formSchema }` — callback payload.

---

### Task 9: Failure ladder — retries → error boundary → incident

Implemented the three-rung failure escalation (design §6.3). `makeLadderRunTask(deps)` replaces the single-attempt `runTask` seam from Task 5.

**Semantics:** Failure = runner throw (schema violation, non-zero exit, SDK error, timeout).
1. **Rung 1 — retry:** up to `contract.retries` attempts (total = retries + 1).
2. **Rung 2 — boundary:** if the node has a modeled error boundary (`profile.errorBoundaryHosts`), rethrow — the engine routes the token to the boundary path.
3. **Rung 3 — incident:** persist `incidents` row, set instance status `'incident'`, notify, **hold** the token (the runner promise stays pending; the engine state is snapshotted). After restart, `resumeAll()` re-invokes the in-flight service `execute` (probe q4); the ladder detects the open incident row and holds immediately without re-running or re-notifying.

**Resolutions via `EngineHost.resolveIncident(incidentId, action, output?)`:**
- `retry` — one fresh attempt; success resolves incident and releases token; failure keeps incident open.
- `skip` — user-supplied output validated against contract's `outputSchema`, then released as task output.
- `abort` — engine stopped, instance `'aborted'`, held promise abandoned.

`InstanceStatus` gained `'incident' | 'aborted'`; `listNonTerminal()` covers `('running','stopped','incident')`.

**Key types:** `makeLadderRunTask()`, `Hold { incidentId, contract, environment, release, attempt }`, `LadderDeps`, `IncidentRow`.

---

### Task 10: task_executions recording + timeline query

Added `task_executions` table recording each runner attempt: nodeId, kind (agent/code/user), attempt number, status (success/failure/skipped), durationMs, output JSON, error text, tokenUsage, costUsd, transcriptPath. Wired recording into dispatch's single-attempt path and inbox submit. Timeline query (`store.getTimeline(instanceId)`) returns ordered execution history for an instance.

---

### Task 11: Minimal REST API + SSE

Built Fastify-based REST API covering instances, inbox, incidents, and timeline. SSE event stream bridges `EngineHost` activity events to connected clients.

**Endpoints:**
- `GET /api/instances` — list all instances.
- `GET /api/instances/:id` — instance detail.
- `POST /api/instances` — start a new instance (body: `{ source, workspace, dryRun?, stubOverrides? }`).
- `GET /api/instances/:id/timeline` — execution timeline.
- `GET /api/inbox` — pending user tasks.
- `POST /api/inbox/:id/submit` — submit user task form.
- `GET /api/incidents` — open incidents.
- `POST /api/incidents/:id/resolve` — resolve incident (body: `{ action, output? }`).
- `GET /api/events` — SSE stream of engine activity events.

---

## M2 exit checklist (impl spec verification gates)

- [ ] M2.1 — moddle parses/serializes a profile-conformant BPMN with contracts intact (Task 1 round-trip test).
- [ ] M2.2 — dry-run instance completes end-to-end with stub output + per-node overrides (Task 5 e2e).
- [ ] M2.3 — code runner contract tests: success, bad JSON, non-zero exit, timeout (Task 6).
- [ ] M2.4 — agent runner mock-transport tests + one recorded live smoke run (Task 7).
- [ ] M2.5 — user task rows + submit resumes token; notifier fired (Task 8).
- [ ] M2.6 — ladder tests for each rung; skip validates output; incident survives restart (Task 9).
- [ ] M2.7 — API integration tests green; SSE observed via curl during a dry run (Task 11).
- [ ] M2.8 — timeline query returns complete step data for a dry run (Task 10).
- [ ] `pnpm build && pnpm test` green across the workspace; M1 suites untouched and passing.

## Deferred (deliberately not in M2)

- `instances.status = 'waiting'` (design data model): the M4 UI can derive waiting from pending user tasks + armed timers; introduce the status when the UI needs it.
- Terminate-end-event → `'terminated'` status: no M2 fixture uses terminate; M3's refined rfp-daily does — add it there.
- The standalone daemon entrypoint (bin script wiring store + host + inbox + api + `resumeAll()` on boot): M2 tests compose these directly; the daemon belongs to M3's dry-run of the real workflow.

## Changelog

- 2026-07-18 — **Compacted post-implementation.** Removed step-by-step tasks, file-by-file diffs, code snippets, and verification commands. Merged findings from `findings_m2-dispatch.md`. Preserved Goal, Global Constraints, task dependency graph, task summaries with key interfaces, dispatch spike findings (including the two-environment correction), exit checklist, and deferred items. Original plan recoverable via git history.
