# Flow Fabric — Design Spec

| | |
|---|---|
| Status | Approved v1 |
| Date | 2026-07-18 |
| PRD | [prd_flow-fabric.md](../product/prd_flow-fabric.md) |
| Implementation | [impl_flow-fabric.md](impl_flow-fabric.md) |

## 1. Architecture decision

Modular monolith, single daemon. One Node process hosts the BPMN engine, scheduler, REST + SSE API, and serves the web UI. Module boundaries are internal packages, not processes.

Alternatives considered:

- **Split daemon + web server**: process isolation, but two things to supervise on one machine for one user. Rejected for v1.
- **Custom BPMN interpreter**: no `bpmn-engine` risk, full control. Rejected in PRD as too expensive; remains the documented fallback if the M1 spike fails (see §10).

## 2. Stack

| Concern | Choice |
|---|---|
| Runtime | Node 22, TypeScript |
| BPMN execution | `bpmn-engine` (embedded) |
| BPMN parse/serialize | `bpmn-moddle` (+ custom `flowfabric` moddle descriptor) |
| HTTP | Fastify: REST + SSE, serves built SPA |
| Storage | SQLite via `better-sqlite3`, WAL mode, in `~/.flow-fabric/` |
| Schema validation | Ajv (task output contracts are JSON Schema) |
| Agent runtime | Claude Agent SDK, headless, one fresh session per task. Endpoint/model/key via `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / `ANTHROPIC_API_KEY` env vars (git-ignored `.env`), so any Claude-compatible API works (e.g. DeepSeek) |
| Frontend | React + Vite, `bpmn-js` for render/overlay |
| Telemetry | OpenTelemetry SDK, OTLP exporter (config-gated) |
| Notifier | macOS notifications: `terminal-notifier`, `osascript` fallback |

Monorepo layout:

```
packages/
  shared/    # types, flowfabric profile schema, lint rule IDs, event types
  server/    # daemon: all modules below
  web/       # SPA
```

Data dir (`~/.flow-fabric/`): SQLite DB, agent transcripts (files), uploaded definition versions. Workspaces are pure workload; the platform never writes its own state there (FR-15).

## 3. Server modules

Each module has one purpose and a defined interface; dependencies point inward toward `events` and the DB.

| Module | Purpose | Key interface |
|---|---|---|
| `definitions` | BPMN file store, immutable versions, deployable flag | `upload(xml)`, `saveVersion(defId, xml, lintReport)`, `get(defId, version)` |
| `profile` | `flowfabric` extension schema, moddle descriptor, task-contract types | types + descriptor JSON, no logic |
| `linter` | Deterministic deployability gate (FR-3, FR-6) | `lint(xml): Finding[]` (pure function) |
| `patch-ops` | Typed BPMN edit operations applied via moddle | `apply(xml, ops[]): {xml, diff}` |
| `grill` | Refinement chat session host | `start(defId)`, `send(msg)`, streams chat + applied-op events |
| `engine-host` | Wraps `bpmn-engine`: lifecycle, persistence, resume, timers, workspace lock | `startInstance(versionId, workspace, opts)`, `resumeAll()`, `signal(instanceId, ...)` |
| `runners` | Task execution for the three actors + stub | `TaskRunner.run(task, inputs, ctx): Promise<Output>` |
| `failure` | Escalation ladder (FR-18) | consulted by engine-host on task failure |
| `events` | Append-only event log, single write path, SSE fan-out, OTel emission | `append(event)`, `subscribe(filter)` |
| `inbox` | Pending user tasks + incidents, form submission | `listPending()`, `submit(taskId, vars)`, `resolveIncident(id, action)` |
| `notify` | Push channel for user tasks + incidents (FR-13) | `notify(title, body, link)` |

## 4. Flow Fabric BPMN profile

### 4.1 Actor mapping (FR-5)

| BPMN element | Actor |
|---|---|
| `bpmn:userTask` | Human |
| `bpmn:scriptTask` | Deterministic code |
| `bpmn:serviceTask` | Agent (Claude) |

Lanes are documentation only. Supported elements (FR-6): start/end events (incl. terminate), exclusive gateways, the three task types, timer intermediate catch events (duration only, e.g. `PT24H`), error boundary events. Linter rejects everything else. `timeCycle` is not supported — bpmn-engine fires it once and ignores the repeat count (M1 spike finding, [findings_m1-spike.md](findings_m1-spike.md)); model recurrence as a gateway loop around a duration timer.

### 4.2 `flowfabric` extension elements

Namespace: `http://flowfabric.dev/schema/1.0`. Contracts live in `bpmn:extensionElements`.

```xml
<bpmn:serviceTask id="Task_audit" name="Audit task tracker">
  <bpmn:extensionElements>
    <flowfabric:agentTask retries="2" timeoutSeconds="600">
      <flowfabric:prompt>Audit the project tracker; flag tasks at risk...</flowfabric:prompt>
      <flowfabric:tools>Read,Grep,Glob,Edit</flowfabric:tools>
      <flowfabric:boundaries>Never modify files outside 30_tracker/</flowfabric:boundaries>
      <flowfabric:input name="deadline" type="string"/>
      <flowfabric:outputSchema>{"type":"object","required":["atRiskTasks"],...}</flowfabric:outputSchema>
    </flowfabric:agentTask>
  </bpmn:extensionElements>
</bpmn:serviceTask>
```

- `scriptTask` → `<flowfabric:codeTask command="..." retries timeoutSeconds>` + inputs + `outputSchema`.
- `userTask` → `<flowfabric:userTask>` + `<flowfabric:formSchema>` (JSON Schema; the inbox renders the form from it).
- Gateway conditions: standard `bpmn:conditionExpression` with `${...}` expressions over process variables only (bpmn-engine native format), e.g. `${environment.variables.deadlinePassed === true}`. Default flow marks the fallback path.

### 4.3 Linter rules (deployability gate)

1. Unsupported element type present → error.
2. Task missing actor contract (`serviceTask` without prompt/outputSchema, `scriptTask` without command, `userTask` without formSchema) → error.
3. Gateway outgoing flow without evaluable condition (except one default flow) → error.
4. Referenced input variable not produced upstream and not declared as instance input → error.
5. Orphan nodes (unreachable from start) → error.
6. Instruction-bearing labels (heuristics: "do not re-run", "ends here") → warning: model as terminate end event or loop condition instead.

Lint report is stored with the version; deployable = zero errors.

## 5. Data model (SQLite)

| Table | Key columns |
|---|---|
| `definitions` | id, name, created_at |
| `definition_versions` | id, definition_id, version_no, xml, lint_report (JSON), deployable, created_at |
| `instances` | id, definition_version_id, workspace_path, status (`running/waiting/incident/completed/terminated/aborted`), engine_state (JSON snapshot), dry_run, started_at, ended_at |
| `task_executions` | id, instance_id, node_id, actor, attempt, resolved_inputs (JSON), output (JSON), status, started_at, ended_at, token_usage (JSON), transcript_path |
| `events` | id (autoinc seq), instance_id, type, payload (JSON), ts (append-only) |
| `user_tasks` | id, instance_id, node_id, form_schema (JSON), status, submitted_vars (JSON) |
| `incidents` | id, instance_id, node_id, task_execution_id, reason, status, resolution, created_at, resolved_at |

Principles:

- `events` is the source of history (FR-16); `instances` is the materialized "now" view.
- `engine_state` is the serialized `bpmn-engine` state, rewritten after every transition (FR-9).
- One active instance per workspace enforced by partial unique index on `instances(workspace_path) WHERE status IN ('running','waiting','incident')` (FR-10).
- Transcripts are files under the data dir; DB stores the path (FR-14).

## 6. Execution semantics

### 6.1 Task lifecycle

1. Engine activates a task node → engine-host looks up the contract, resolves declared input variables from process variables.
2. Dispatch to runner by actor. Runner contract: return JSON validated against `outputSchema` (Ajv), or throw.
3. Valid output merges into process variables under the task's declared output names. Engine continues; token moves per gateway conditions.
4. Every execution recorded in `task_executions` + events (FR-14).

Runner specifics:

- **Agent**: fresh headless Claude Agent SDK session, `cwd` = workspace, allowed tools from contract, prompt = contract prompt + boundaries + serialized inputs. The SDK inherits `ANTHROPIC_*` env vars from the daemon, which loads them from `.env` at boot — model and endpoint are deployment config, not per-task contract fields. Must end with JSON matching the output schema (extracted from the final message; retry within the same attempt once on parse failure). Stateless between tasks (FR-11).
- **Code**: spawn declared command in workspace; inputs as env vars (`FF_VAR_*`) and JSON on stdin; stdout parsed as JSON output (FR-12).
- **User**: create `user_tasks` row, render form from formSchema in inbox, fire notifier. Submission validates against schema, writes vars, resumes token (FR-13).
- **Stub** (dry-run): generates schema-conforming fake output (`json-schema-faker`-style derivation), optional per-node override values supplied at instance start. Applies to agent + code tasks; user tasks stay real so the human steers gateway paths cheaply.

### 6.2 Durability (FR-9)

- Persist engine state on every `activity.start`, `activity.end`, `activity.wait`, timer registration.
- On daemon boot: `resumeAll()` loads non-terminal instances, recreates engines from `engine_state`, re-arms timers with remaining duration computed from persisted fire-at timestamps.
- M1 spike validates exactly this against a multi-hour timer before anything else is built (§10).

### 6.3 Failure ladder (FR-17, FR-18)

Failure = output fails schema validation, command non-zero exit, SDK error, or timeout.

1. Retry up to contract `retries` (attempt counter on `task_executions`).
2. If the node has a modeled error boundary event → route token there.
3. Else raise incident: token pauses, `incidents` row, inbox entry, notification. Resolutions: **retry** (new attempt), **skip** (user supplies output JSON, validated against schema, merged), **abort** (instance → aborted).

No silent stalls: every non-terminal halt is either an engine wait state (timer, user task) visible in the UI, or an incident (FR-19).

## 7. Intake and grilling

1. **Upload**: any BPMN 2.0 file; stored as version 1, rendered with bpmn-js regardless of executability (FR-1).
2. **Grill session** (FR-2): chat panel beside the rendered diagram. Server hosts a Claude Agent SDK session with the diagram model in context and exactly one mutating tool: `propose_patch_ops(ops[])`.
   - Agent walks the diagram node by node, interrogates the user (actor assignment, contracts, gateway conditions, label semantics).
   - Proposed ops are applied by `patch-ops` (deterministic), the diagram re-renders, the linter re-runs, and findings feed back into the session.
   - The agent never edits XML directly, so DI layout is untouched by construction (risk #3).
3. **Patch op set**: `setTaskType(nodeId, bpmnType)`, `setTaskContract(nodeId, contract)`, `setGatewayCondition(flowId, expression, isDefault)`, `replaceLabel(nodeId, newLabel)`, `convertToTerminateEnd(nodeId)`, `addErrorBoundary(nodeId, targetId)`, `setTimerDefinition(nodeId, iso8601)`, `declareInstanceInput(name, type)`.
4. **Versioning** (FR-4): each grill session ends with an explicit "save version"; versions are immutable; running instances stay pinned to their version.

## 8. API surface

REST (all under `/api`):

- `POST /definitions` (upload), `GET /definitions`, `GET /definitions/:id/versions/:v`, `POST /definitions/:id/versions/:v/lint`
- `POST /grill/sessions` `{definitionId}`, `POST /grill/sessions/:id/messages`, `POST /grill/sessions/:id/save-version`
- `POST /instances` `{versionId, workspacePath, dryRun, inputs, stubOverrides?}`, `GET /instances`, `GET /instances/:id` (incl. timeline), `POST /instances/:id/abort`
- `GET /inbox` (user tasks + incidents), `POST /user-tasks/:id/submit`, `POST /incidents/:id/resolve` `{action, output?}`
- `GET /metrics/definitions/:id` (aggregates), `GET /healthz`, `GET /scheduler` (next timer firings, FR-25)

SSE: `GET /api/events?instanceId=...`. Event types: `instance.started/completed/terminated/aborted`, `task.started/completed/failed`, `token.moved`, `timer.armed/fired`, `incident.raised/resolved`, `usertask.created/submitted`, `grill.op-applied`, `lint.updated`.

## 9. Web UI

Pages: **Definitions** (list, upload, versions, lint report), **Refine** (bpmn-js render + grill chat + live diff/lint panel), **Instances** (list + live diagram view with token overlay and per-node status, FR-20; timeline tab with inputs/outputs/durations/transcript links/cost, FR-21), **Inbox** (user task forms + incident resolution, FR-22), **Dashboards** (success rate, duration distribution, cost per run/task, incident frequency as SQL aggregates, FR-23), **System** (health, scheduler state, platform logs).

Forms are rendered from JSON Schema (`@rjsf` or equivalent); complex inputs (files, tables) are out of scope for v1 form generation; escape hatch is a free-form JSON field (PRD §9).

## 10. Observability internals

- Every event append emits an OTel span/event: trace per instance, span per task execution, attributes: node id, actor, attempt, token usage, cost (FR-24).
- Metrics: counters (task success/failure, incidents), histograms (task + run duration, cost). OTLP exporter config-gated; off by default.
- Structured platform logs (pino) separate from workflow events (FR-25).

## 11. Testing strategy

| Layer | Approach |
|---|---|
| Linter | Unit tests on fixture BPMNs, incl. both real Input files (rfp-daily must fail pre-grill, pass post-grill) |
| Patch ops | Round-trip tests: apply op, assert semantic change present and DI section byte-identical outside targeted elements |
| Engine-host | Kill-and-resume: start instance with timer, kill process, restart, assert timer fires at original schedule (risk #1) |
| Runners | Contract tests per runner; agent runner against a mock SDK transport |
| Failure ladder | Simulated failures at each rung: retry exhaustion → boundary routing → incident lifecycle |
| E2E | Refined rfp-daily completes a full dry-run daily cycle; interview-process imports and lints without execution (G2) |

Dry-run mode doubles as the E2E harness: same engine, stub runners.

## 12. Risks (delta from PRD §9)

- **bpmn-engine fit**: addressed by M1 spike gate; fallback path (custom interpreter) decided in week 1.
- **DI corruption**: eliminated by patch-ops design; verified by round-trip tests.
- **Grilling quality**: dry-run in v1 scope; first real run only after a clean dry-run cycle.
- **Fresh-session cost**: measured via per-task token recording from day one; shared context priming deferred until data shows need.
- **Stub realism**: schema-derived fakes may not exercise realistic gateway paths; per-node stub overrides mitigate.
