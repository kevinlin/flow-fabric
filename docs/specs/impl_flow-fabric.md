# Flow Fabric — Implementation Spec

| | |
|---|---|
| Status | Approved v1 |
| Date | 2026-07-18 |
| Design | [design_flow-fabric.md](design_flow-fabric.md) |

Five milestones, each with numbered tasks and a verification gate. M1 is a go/no-go gate on `bpmn-engine`; nothing else starts until it passes.

## M1 — Engine spike / walking skeleton

Goal: prove `bpmn-engine` supports durable resume and timer persistence (PRD risk #1).

1. Scaffold monorepo (`packages/shared`, `packages/server`, `packages/web` placeholder), TS config, vitest.
   - Verify: `pnpm build && pnpm test` green.
2. Minimal `engine-host`: load a hand-written test BPMN (start → script task → 10s timer → script task → end), run in-process with inline JS tasks.
   - Verify: instance completes; transitions logged.
3. State persistence: SQLite (`instances`, `events` tables), serialize engine state after every transition.
   - Verify: DB rows show state snapshots per transition.
4. Resume: `resumeAll()` on boot. Kill the process mid-timer, restart; instance continues and completes.
   - Verify: automated kill-and-resume test; timer fires at originally scheduled time, not reset.
5. Cycle timer: `R/PT24H`-style loop (shrunk to seconds in test) fires repeatedly across a restart.
   - Verify: automated test, ≥3 cycles with one restart in between.
6. **Gate**: document spike findings. If any of 4–5 fails and no workaround exists in `bpmn-engine`, stop and re-plan on the custom-interpreter fallback (design §1).

## M2 — Runners + failure ladder

Goal: three actors + stub execute real task contracts; failures escalate per FR-18.

1. `shared`: `flowfabric` profile types, moddle descriptor, contract schemas.
   - Verify: moddle parses/serializes a hand-written profile-conformant BPMN with contracts intact.
2. `TaskRunner` interface + **stub runner** (schema-derived fake output, per-node overrides).
   - Verify: dry-run instance of test BPMN completes end-to-end.
3. **Code runner**: spawn command in workspace, `FF_VAR_*` env + stdin JSON, stdout JSON validated with Ajv.
   - Verify: contract tests for success, bad JSON, non-zero exit, timeout.
4. **Agent runner**: headless Claude Agent SDK session, cwd = workspace, tools from contract, output JSON extracted and validated; token usage + transcript path recorded. SDK endpoint/model/key from `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL` / `ANTHROPIC_API_KEY` env vars (`.env`), supporting Claude-compatible APIs.
   - Verify: contract test against mock transport; one live smoke test against a scratch workspace.
5. **User task service**: `user_tasks` rows, submit API writes vars and resumes token; macOS notifier fires on creation.
   - Verify: integration test (notifier mocked); manual notification check.
6. **Failure ladder**: retries → error boundary routing → incident (raise, list, resolve retry/skip/abort).
   - Verify: automated tests for each rung; skip validates user-supplied output against schema.
7. Minimal REST API: create/list/inspect instances, submit user tasks, resolve incidents; SSE event stream.
   - Verify: API integration tests; `curl` an SSE stream during a dry run.
8. `task_executions` recording: inputs, outputs, timing, attempt, token usage (FR-14).
   - Verify: timeline query returns complete step data for a dry run.

## M3 — Intake: profile, linter, patch ops, grill

Goal: real `rfp-daily-routine.bpmn` becomes deployable; `interview-process.bpmn` imports and lints (G2).

1. Definition store + immutable versions + upload API.
   - Verify: upload both Input files; versions persisted, retrievable.
2. **Linter**: rules 1–6 from design §4.3, report stored per version.
   - Verify: unit tests per rule on fixtures; raw rfp-daily fails with specific findings; hand-refined fixture passes.
3. **Patch ops**: op set from design §7.3 applied via moddle.
   - Verify: round-trip tests; semantic change applied, DI byte-identical outside targeted elements (risk #3).
4. **Grill session host**: SDK session, `propose_patch_ops` tool, ops applied deterministically, re-lint feedback loop, chat over SSE.
   - Verify: scripted session converts a small messy fixture to deployable without manual XML edits.
5. Grill the real files: refine rfp-daily to deployable; import interview-process and confirm lint behavior.
   - Verify: rfp-daily version passes linter; refined file still opens cleanly in a stock BPMN editor (layout intact).
6. Dry-run the refined rfp-daily.
   - Verify: full daily cycle completes with stub agents + real user tasks; timer loop reaches second iteration.

## M4 — Web UI + notifier polish

Goal: FR-20..23 visible; product presentable.

1. SPA shell, routing, SSE client, API client.
   - Verify: pages load against live server.
2. **Definitions + Refine** pages: bpmn-js render, grill chat panel, live lint panel, version save.
   - Verify: grill session usable end-to-end from browser.
3. **Instances** page: live diagram with token overlay + per-node status (FR-20); timeline tab with inputs/outputs/durations/transcript links/cost (FR-21).
   - Verify: watch a dry run live; every executed step visible with full data (success criterion 3).
4. **Inbox**: JSON-Schema-rendered forms, free-form JSON escape hatch, incident resolution actions (FR-22).
   - Verify: submit a real user task and resolve a forced incident from the browser.
5. **Dashboards**: success rate, duration distribution, cost per run/task, incident frequency (FR-23).
   - Verify: aggregates match seeded test data.
6. **System** page: health, scheduler (next timer firings), platform logs (FR-25).
   - Verify: 24h timer shows correct next-fire time.

## M5 — OTel + soak (G1 acceptance)

1. OTel traces (instance → task spans) + metrics, OTLP exporter config-gated (FR-24).
   - Verify: spans visible in a local collector (e.g. Jaeger) for a dry run.
2. First real (non-dry) rfp-daily run against the RFP workspace, supervised.
   - Verify: cycle completes; token cost per task reviewed for the fresh-session cost risk.
3. 7-day unattended soak: daemon under launchd/pm2, real workspace.
   - Verify: ≥7 consecutive daily cycles, zero silent stalls; every halt is a modeled end event or a surfaced incident (success criterion 1).
4. Close out: measure agent-task cost; decide whether shared context priming is needed (PRD §9).

## Dependencies and ordering

- M1 gates everything (fallback re-plan if it fails).
- M2 tasks 2–5 are parallelizable after task 1; task 6 depends on 2–4.
- M3 depends on M2 task 1 (shared profile) and the M2 engine/runner path for dry-run verification.
- M4 depends on M2 API + M3 grill endpoints.
- M5 depends on all prior.

## Out of scope (PRD §7 "Later" column)

Parallel/event gateways, message events, subprocesses, multi-instance; concurrent instances per workspace; non-Claude runners; multi-user/auth; alerting rules, SLOs, cost budgets; executing the interview process.
