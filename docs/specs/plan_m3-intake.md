# M3 Intake Implementation Plan — Profile, Linter, Patch Ops, Grill

**Goal:** Made the real `rfp-daily-routine.bpmn` (Signavio export) deployable through upload → lint → grill → versioned save, and `interview-process.bpmn` imports and lints (G2); the refined flagship dry-runs end-to-end (impl spec M3.1–M3.6).

**Architecture:** Four new server modules — `definitions` (immutable version store), `linter` (pure deployability gate, design §4.3), `patch-ops` (typed moddle edits that never touch DI, design §7.3), `grill` (Claude Agent SDK chat session whose only mutating tool is `propose_patch_ops`) — plus a daemon entrypoint (deferred from M2) and terminate-end status. `packages/shared` gained lint rule IDs/types and an `instanceInputs` profile extension. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M3, [design_flow-fabric.md](design_flow-fabric.md) §3, §4.3, §7, §8.

**Tech Stack:** Node 22, TypeScript (strict, ESM, NodeNext), pnpm workspaces, `bpmn-moddle` ^10, `better-sqlite3` ^12, `fastify` ^5, `@anthropic-ai/claude-agent-sdk` ^0.3 (with `createSdkMcpServer`/`tool` + `zod` ^4), vitest ^3.

## Design Decisions

**Gateway condition format (M3 finding, amended design §4.2):** Gateway conditions use `language="javascript"` with `next(null, <bool>)` semantics — the format proven in M1/M2 and compiled by `createDispatch`'s `scripts` hook. Design §4.2's `${...}` expression format was rejected: the scripts hook compiles every condition body with `new Function`, and `${...}` is a JS syntax error at registration. The linter (rule FF003) accepts only javascript-language conditions; the `setGatewayCondition` patch op wraps user expressions as `const environment = this.environment; next(null, Boolean(<expr>));`.

**Patch ops DI stability (design §7, risk #3):** Ops never edit XML text directly and never touch `<bpmndi:*>` sections except when an op *adds* an element (`addErrorBoundary` adds its own shape/edge). DI stability is asserted by normalize-compare: both sides pass through the same serializer, so formatting noise cancels out.

**`setTaskType` reference surgery:** Moddle elements are linked by object reference (flows' `sourceRef`/`targetRef`, lane `flowNodeRef`, DI `bpmnElement`), so retyping means creating a new element and re-pointing every reference — not just renaming the `$type`.

**Grill deterministic core:** The `applyOps` → re-lint → events cycle is the deterministic core of `GrillSession`. The SDK tool handler (`propose_patch_ops`) and tests/CLI all drive this same path, so the deterministic behavior is tested without live SDK calls.

**No `removeNode` op (accepted v1 gap):** Orphan nodes (linter rule FF005) cannot be fixed by grilling — the user fixes them in the source editor and re-uploads. The grill briefing tells the agent to say exactly that.

**`bpmn-moddle` v10 ambient shim:** Ships no types; the `declare module 'bpmn-moddle'` shim in `packages/server/src/types/bpmn-moddle.d.ts` covers it. Access moddle element shapes dynamically (`any`), matching `profile/read.ts`.

## Task Overview

Dependencies: 3–4 need 1; 5–6 need 1; 7 needs 4+6 (and 2 for save-version); 8 needs 7; 9 needs 4 (fixture) + 8 (instances-by-version route); 10 needs everything. Tasks 2, 3, 5 are parallelizable after 1.

### Task 1: Shared profile additions — lint types, `instanceInputs`, `terminateEnds`

Added lint rule IDs (`LINT_RULES` constant `FF001`–`FF006`), `LintFinding`/`LintReport` types to `@flowfabric/shared`, the `InstanceInputs` moddle descriptor type, and `instanceInputs: InputDecl[]` + `terminateEnds: Set<string>` to `ProcessProfile`. The `instanceInputs` XML shape sits as `<flowfabric:instanceInputs>` under the process element's extension elements.

Key types in `packages/shared/src/lint/types.ts`: `LINT_RULES` (6 rule IDs), `LintFinding { rule, severity, nodeId?, message }`, `LintReport { findings, errorCount, deployable }`.

### Task 2: DefinitionStore — immutable versions + upload API (impl M3.1)

Built the BPMN file store (`packages/server/src/definitions/store.ts`): `definitions` and `definition_versions` tables in SQLite (WAL), versions immutable, deployable flag from the lint report. API routes: `POST /api/definitions`, `GET /api/definitions`, `GET /api/definitions/:id/versions/:v` (`:v` may be `latest`).

Key API: `DefinitionStore { upload(name, xml), saveVersion(defId, xml, report?), setLintReport(defId, v, report), getDefinition(id), listDefinitions(), getVersion(defId, v), getLatestVersion(defId), close() }`.

### Task 3: Linter rules 1–3 — unsupported elements, missing contracts, unevaluable conditions (impl M3.2)

Implemented the pure `lint(xml): Promise<LintReport>` function (`packages/server/src/linter/lint.ts`). FF001 flags non-profile elements (generic `<task>`, parallel gateways, timeCycle timers, etc.). FF002 flags tasks missing their actor contract (serviceTask without prompt/outputSchema, scriptTask without command, userTask without formSchema). FF003 flags branching gateway flows without a `language="javascript"` conditionExpression (one default flow per gateway is allowed unconditioned). Unparseable XML returns a single FF001 error finding instead of throwing.

### Task 4: Linter rules 4–6, lint endpoint, refined fixture, real-file assertions (impl M3.2)

Added graph-based rules: FF004 (undeclared variables — input not produced upstream or declared as instance input) using BFS reachability, FF005 (orphan nodes — unreachable from any start event), FF006 (instruction-bearing labels like "do not re-run" — warning only, doesn't block deployment). Wired `POST /api/definitions/:id/versions/:v/lint` endpoint that stores the report on the version. Created the `daily-loop-refined.bpmn` fixture — the rfp-daily shape fully contracted and deployable, with `PT2S` timer for E2E test loops.

### Task 5: Patch ops — in-place operations (impl M3.3)

Implemented `applyPatchOps(xml, ops): Promise<PatchResult>` (`packages/server/src/patch-ops/apply.ts`) for the five in-place ops: `setTaskContract` (writes the actor contract readable by `readProfile`), `setGatewayCondition` (wraps the expression in the javascript `next()` format), `replaceLabel`, `setTimerDefinition`, `declareInstanceInput`. All-or-nothing: any failing op rejects the whole call. `PatchOpError` is the typed failure class.

Op union type: `PatchOp = setTaskType | setTaskContract | setGatewayCondition | replaceLabel | convertToTerminateEnd | addErrorBoundary | setTimerDefinition | declareInstanceInput`.

### Task 6: Patch ops — structural operations + DI stability (impl M3.3, risk #3)

Implemented the three structural ops. `setTaskType` creates a new moddle element and re-points every object reference (sequence flows, boundary attachments, lanes, DI shapes) via the `replaceElement` helper. `convertToTerminateEnd` handles both real end events and dead-end tasks. `addErrorBoundary` is the only op that adds elements — it also adds its own DI shape/edge so the file still opens in stock editors. DI stability verified by normalize-compare on fixtures and on the real Signavio export.

### Task 7: Grill session host (impl M3.4)

Built `GrillSession`/`GrillHost` (`packages/server/src/grill/session.ts`). The session holds a working copy of the XML and a lint report. `applyOps` is the deterministic core (apply → re-lint → emit events). `send()` drives one Claude Agent SDK chat turn: first turn carries the briefing (diagram XML + lint report + op catalog), later turns resume the SDK session. The `propose_patch_ops` tool is an in-process SDK MCP server (`createSdkMcpServer` + `tool()` with a `zod` ^4 schema). `saveVersion()` persists the working copy as the next immutable version. Tests script the session via `applyOps()` directly + a mock `AgentQueryFn`.

Event types: `chat | op-applied | lint-updated | op-rejected | turn-done | error`.

### Task 8: Grill API + instances-by-version + daemon entrypoint (impl M3.4, M2 deferral)

Exposed the grill over REST + SSE: `POST /api/grill/sessions`, `POST /api/grill/sessions/:id/messages` (202, turn runs async), `POST /api/grill/sessions/:id/save-version`, `GET /api/grill/sessions/:id/events` (SSE). Extended `POST /api/instances` to accept `definitionId`/`version` — resolves the version XML, enforces the lint deployability gate (400 if not deployable). Built the daemon entrypoint (`packages/server/src/daemon.ts`): wires store + host + inbox + notifier + definitions + grill + API, calls `resumeAll()`, listens on `FF_PORT` (default 4400).

### Task 9: Terminate-end status + automated dry-run E2E (impl M3.6 mechanics)

Added `'terminated'` to `InstanceStatus` (terminal, like `'completed'`). `EngineHost` detects when a token reaches a terminate end event (via `ProcessProfile.terminateEnds`) and sets the instance status to `'terminated'` instead of `'completed'`. Automated E2E (`dry-run-e2e.test.ts`) exercises both branches of the refined fixture: init branch (stub → user task → terminate end) and audit loop (stub override → audit → review → timer → 2nd iteration → exit).

### Task 10: Real-file gate — grill CLI, grill the real files, dry-run refined rfp-daily, doc amendments (impl M3.5 + M3.6 verify)

Built the interactive grill CLI (`packages/server/scripts/grill-cli.ts`) — readline wrapper around `DefinitionStore` + `GrillHost` with `/lint`, `/save`, `/quit` commands. Used it to grill `rfp-daily-routine.bpmn` to deployable (19 generic tasks → actor contracts, 6 gateways → conditions, instruction labels → terminate ends, deadline → instance input). Grilled `interview-process.bpmn` to deployable (G2). Dry-ran the refined rfp-daily through the daemon. Amended design §4.2 (condition format) and CLAUDE.md (M3 state).

## Critical Files

| Path | Role |
|---|---|
| `packages/shared/src/lint/types.ts` | Lint rule IDs, `LintFinding`, `LintReport` types |
| `packages/shared/src/profile/descriptor.ts` | `InstanceInputs` moddle type |
| `packages/server/src/profile/read.ts` | `instanceInputs`, `terminateEnds` in `ProcessProfile` |
| `packages/server/src/definitions/store.ts` | Immutable BPMN version store (SQLite) |
| `packages/server/src/linter/lint.ts` | Pure `lint(xml)` deployability gate, rules FF001–FF006 |
| `packages/server/src/patch-ops/apply.ts` | `applyPatchOps`: typed moddle edits, DI-stable |
| `packages/server/src/grill/session.ts` | `GrillSession`/`GrillHost`: Claude chat + `propose_patch_ops` |
| `packages/server/src/api/server.ts` | Definitions, lint, grill, instances-by-version routes |
| `packages/server/src/daemon.ts` | Process entrypoint wiring all modules |
| `packages/server/src/engine-host/store.ts` | `InstanceStatus` gained `'terminated'` |
| `packages/server/src/engine-host/engine-host.ts` | Terminate-end detection via `ProcessProfile.terminateEnds` |
| `packages/server/scripts/grill-cli.ts` | Interactive terminal grill (M3.5 gate; replaced by M4 web UI) |
| `packages/server/test/fixtures/messy.bpmn` | Miniature Signavio export for linter/grill tests |
| `packages/server/test/fixtures/daily-loop-refined.bpmn` | Fully contracted rfp-daily shape for E2E |

## M3 Exit Checklist

- [ ] M3.1 — both Input files upload; versions persisted and retrievable (Task 2 tests incl. skipIf real-file test).
- [ ] M3.2 — unit tests per lint rule on fixtures; raw rfp-daily fails with specific findings; hand-refined fixture passes (Tasks 3–4).
- [ ] M3.3 — patch-op round-trip tests; semantic change applied, DI byte-identical outside targeted elements (Tasks 5–6, incl. real Signavio file).
- [ ] M3.4 — scripted session converts messy.bpmn to deployable without manual XML edits (Task 7); chat + ops over SSE (Task 8).
- [ ] M3.5 — real rfp-daily refined to deployable via grill CLI; refined file opens cleanly in a stock BPMN editor; interview-process imports, lints as expected, and grills to deployable (Task 10, steps 2–4).
- [ ] M3.6 — dry run of the refined rfp-daily completes a full daily cycle with stub agents + real user tasks; timer loop reaches the second iteration (Task 9 automated on the fixture; Task 10 step 5 on the real file).
- [ ] `pnpm build && pnpm test` green across the workspace; M1/M2 suites untouched and passing.

## Deferred (deliberately not in M3)

- `instances.status = 'waiting'` — still M4's call (UI derives it until then).
- `removeNode` patch op — orphans are fixed in the source editor and re-uploaded; revisit only if real grilling sessions hit it painfully.
- `GET /api/metrics/*`, `GET /api/scheduler` — M4 dashboards / system page (design §8 lists them; nothing consumes them before the UI).
- Grill session persistence across daemon restarts — sessions are in-memory; a killed daemon means re-opening the grill from the last saved version. Acceptable for a single-user local tool in M3.

## Changelog

- 2026-07-19 — **Compacted post-implementation.** Removed step-by-step tasks, file-by-file diffs, code snippets, and verification commands now that the feature has shipped. Preserved Goal, Architecture, Design Decisions, Critical Files summary, and follow-ups. Original plan recoverable via git history.
- 2026-07-18 — Initial plan.
