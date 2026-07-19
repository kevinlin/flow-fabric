# M4 Web UI + Notifier Polish Implementation Plan

**Goal:** Built the six web pages from design §9 (Definitions, Refine, Instances, Inbox, Dashboards, System) against the live daemon, covering FR-20..23 and FR-25, with notifications deep-linking into the inbox (impl spec M4.1–M4.6).

**Architecture:** Server first, UI second. Tasks 1–8 closed the API gaps the UI needed (definition linkage on instances, metrics aggregates, scheduler state, platform logs, SSE event vocabulary, transcript/grill-state/version-list routes, shared DTO types, static SPA serving) — each was a normal TDD server task. Tasks 9–15 built `packages/web`: Vite + React SPA, `bpmn-js` NavigatedViewer for diagram render + token overlay, native `EventSource` for SSE, a small hand-rolled JSON-Schema form (flat schemas only, free-form JSON escape hatch per design §9). Task 16 was the styling pass, docs, and the manual M4 exit gate. Spec: [impl_flow-fabric.md](impl_flow-fabric.md) M4, [design_flow-fabric.md](design_flow-fabric.md) §8, §9.

**Tech Stack:** Node 22, TypeScript (strict, ESM), pnpm workspaces, `fastify` ^5 + `@fastify/static` ^8, `better-sqlite3` ^12, React ^19, `react-router-dom` ^7, `bpmn-js` ^18, Vite ^7, vitest ^3 (+ jsdom ^26, `@testing-library/react` ^16 in web).

## Design Decisions

- **`instances.status = 'waiting'` stays deferred.** The UI derives a "waiting" display label from pending user tasks + armed timers (the M2/M3 deferral said "introduce the status when the UI needs it" — the UI needs the *label*, not the column). Pure function in web, unit-tested; no engine or schema change.
- **No `@rjsf`, no chart library.** Every formSchema the profile produces is a flat object of primitives; a ~90-line `SchemaForm` component plus the JSON escape hatch covers FR-13/design §9 without rjsf's theming surface. Dashboards are SQL aggregates rendered as stat tiles and CSS bars — a chart lib buys nothing at this data volume.
- **Metrics need instance→definition linkage.** `instances` rows never recorded which definition version started them (M2 predates the definition store). Task 1 added nullable `definition_id`/`version_no` columns with a `PRAGMA table_info` migration guard so existing `~/.flow-fabric` DBs keep working.
- **Scheduler state is in-memory.** `EngineHost` records `expireAt` from the `activity.timer` message content into a map, cleared on `activity.timeout`/`activity.end`. Durable timer state already lives in `engine_state`; the map is just the queryable "now" view and rebuilds on resume because recovery re-emits `activity.timer`. (If a bpmn-engine version stops re-emitting it on resume, fall back to parsing timers out of the recovered state in `resumeAll()` — the scheduler test catches it.)
- **Transcript links serve file content by row id.** `GET /api/task-executions/:id/transcript` reads the `transcript_path` stored on the row. No user-supplied paths ever reach `fs` — the path comes only from the DB.
- **Web package uses Bundler resolution.** `moduleResolution: "Bundler"`, extensionless relative imports, `noEmit` (Vite builds; `tsc` typechecks). The server/shared NodeNext `.js`-extension rule does not apply inside `packages/web`.
- **Web imports `@flowfabric/shared` (built dist).** DTO types live in shared; the server pins its row types against them with compile-time assignments (Task 7) instead of refactoring rows out of `store.ts`.

## Global Constraints

Server/shared: `NodeNext` + `.js`-extension local imports. Web: `Bundler` resolution, extensionless imports. All packages ESM + TS `strict`. Full constraints documented in project-level CLAUDE.md; M4 added `@fastify/static` (server) and `react`, `react-dom`, `react-router-dom`, `bpmn-js`, `vite`, `@vitejs/plugin-react`, `vitest`, `jsdom`, `@testing-library/react` (web).

## Critical Files

| Path | Change |
|---|---|
| `packages/server/src/engine-host/store.ts` | `definition_id`/`version_no` columns + migration guard; `metricsForDefinition`; `getTaskExecution` |
| `packages/server/src/engine-host/engine-host.ts` | Armed-timer registry (`scheduledTimers()`); `incident.resolved` event; start opts pass-through for definition linkage |
| `packages/server/src/engine-host/failure.ts` | Notify link + instance name in incident copy |
| `packages/server/src/inbox/inbox.ts` | `usertask.created`/`usertask.submitted` events; notify deep link |
| `packages/server/src/notify/notifier.ts` | `DEFAULT_INBOX_LINK` constant |
| `packages/server/src/definitions/store.ts` | `listVersions` method |
| `packages/server/src/api/server.ts` | Routes: metrics, scheduler, logs, versions, grill state, transcript; DTO type pins; `@fastify/static` SPA serving with API-priority fallback |
| `packages/server/src/daemon.ts` | `LogRing` wiring, `webRoot` path computation |
| `packages/server/src/logs/ring.ts` | Created: bounded in-memory log buffer (acts as pino stream) |
| `packages/shared/src/api/types.ts` | Created: API DTO types (`InstanceDto`, `DefinitionMetricsDto`, etc.) consumed by web, pinned by server |
| `packages/web/` | Created: Vite + React SPA — six pages, API client, SSE hook, `BpmnCanvas`, `SchemaForm`, `LintPanel`, pure libs (`node-status`, `instance-view`, `chat`, `logs`) |

## Task Overview

1. Server — instances record their definition version (+ timestamps exposed)
2. Server — metrics aggregates + `GET /api/metrics/definitions/:id`
3. Server — armed-timer registry + `GET /api/scheduler`
4. Server — platform log ring buffer + `GET /api/logs` + daemon logger
5. Server — SSE event vocabulary + notifier polish (links, instance names)
6. Server — API gap fill: version list, grill session state, transcript
7. Shared — API DTO types; server response shaping + type pins
8. Server — serve the built SPA
9. Web — scaffold: Vite/React/Router, API client, SSE hook, shell
10. Web — Definitions page (upload, versions, lint, start instance)
11. Web — BpmnCanvas + Refine page (grill chat, live lint, save version)
12. Web — Instances pages: live diagram overlay (FR-20) + timeline (FR-21)
13. Web — Inbox page: schema forms, escape hatch, incidents (FR-22)
14. Web — Dashboards page (FR-23)
15. Web — System page (FR-25)
16. Styling pass, docs, M4 exit gate

---

### Task 1: Instances record their definition version

Added `definition_id`/`version_no` nullable columns to `instances` with a `PRAGMA table_info` migration guard for pre-M4 DBs. Exposed `createdAt`/`updatedAt` on `InstanceRow`. `POST /api/instances` passes definition linkage through to `EngineHost.start`.

### Task 2: Metrics aggregates + `GET /api/metrics/definitions/:id`

Implemented `metricsForDefinition(definitionId)` as SQL aggregates over `instances` + `task_executions` + `incidents` (runs by status, success rate, durations of successful runs, cost per run and per task, incident counts). Exposed via `GET /api/metrics/definitions/:id`.

### Task 3: Armed-timer registry + `GET /api/scheduler`

Added an in-memory `Map<string, ArmedTimer>` to `EngineHost`, populated on `activity.timer` (using `content.expireAt`), cleared on `activity.timeout`/`activity.end`/instance stop. Exposed via `scheduledTimers()` and `GET /api/scheduler`. Stragglers cleaned in the `run()` finally block.

### Task 4: Platform log ring buffer + `GET /api/logs` + daemon logger

Created `LogRing` (bounded ring buffer with configurable capacity, acts as a pino writable stream). Wired into the daemon's Fastify logger so platform logs are capturable in-memory. Exposed via `GET /api/logs?limit=n`.

### Task 5: SSE event vocabulary + notifier polish

Added `usertask.created`, `usertask.submitted`, and `incident.resolved` events to the event log (fanned out over SSE). Gave the notifier a `DEFAULT_INBOX_LINK` constant (`http://127.0.0.1:4400/#/inbox`) used as the deep link for both user-task and incident notifications.

### Task 6: API gap fill — version list, grill session state, transcript

Added `DefinitionStore.listVersions`, `InstanceStore.getTaskExecution`, and three routes: `GET /api/definitions/:id/versions`, `GET /api/grill/sessions/:id` (returns current XML + lint without replaying chat), `GET /api/task-executions/:id/transcript` (serves file content by DB row id — no user-supplied paths reach `fs`).

### Task 7: Shared API DTO types + server response shaping

Created `packages/shared/src/api/types.ts` with all API DTOs (`InstanceDto`, `InstanceDetailDto`, `InboxDto`, `DefinitionMetricsDto`, `SchedulerDto`, `LogsDto`, etc.). Added compile-time type pins in `server.ts` (`_MetricsPin`, `_SchedulerPin`) so server return shapes cannot drift from DTOs without a build break.

### Task 8: Serve the built SPA from the daemon

Registered `@fastify/static` on `packages/web/dist` with `wildcard: false` and a `setNotFoundHandler` SPA fallback that returns `index.html` for non-`/api/` paths. API routes keep priority because they're registered first. The daemon computes `webRoot` as `../../web/dist` relative to `daemon.ts`.

### Task 9: Web scaffold — Vite/React/Router, API client, SSE hook, shell

Replaced the `packages/web` echo-script placeholder with a real Vite + React 19 SPA. Typed `api` client over shared DTOs, `useEventStream` hook (native `EventSource`, ref-held callback to avoid stream reopens), hash-router app shell with sidebar navigation, and stub pages for all six routes.

### Task 10: Definitions page — upload, versions, lint, start instance

Built the Definitions page: list definitions, upload a BPMN file, show versions with lint/deployable state, lint on demand, start an instance from a deployable version, and link into Refine. Created the reusable `LintPanel` component (shared with Refine page).

### Task 11: BpmnCanvas + Refine page — grill chat, live lint, save version

Built `BpmnCanvas` (`bpmn-js` `NavigatedViewer` wrapper with per-element CSS marker overlay via `addMarker`/`removeMarker`) and the Refine page (starts a grill session, renders chat with `messageToText` helper, live lint panel via SSE, version save button).

### Task 12: Instances pages — live diagram overlay (FR-20) + timeline (FR-21)

Built the Instances list (SSE-refreshed) and detail page with live diagram overlay using `nodeMarkers` (last relevant event per node → CSS class), `deriveDisplayStatus` (waiting label derived from pending user tasks + armed timers), and a full timeline table with inputs/outputs/durations/cost/transcript links plus `fmtDuration`/`fmtCost`/`fmtTime` formatters.

### Task 13: Inbox page — schema forms, escape hatch, incident resolution (FR-22)

Built `SchemaForm` (~90 lines, handles flat JSON-Schema objects of primitives with type coercion, plus a raw-JSON escape hatch toggle) and the Inbox page showing pending user tasks (with form submission) and open incidents (retry / skip-with-output / abort actions).

### Task 14: Dashboards page (FR-23)

Built the Dashboards page rendering `metricsForDefinition` as stat tiles (success rate, run counts, active, open incidents), CSS bar charts (duration distribution), and a cost-per-task table with per-node run counts, total cost, and avg duration. No chart library.

### Task 15: System page (FR-25)

Built the System page showing daemon health (fetch `/api/healthz`), armed-timer table with next-fire times and countdown, and a streaming platform log viewer (auto-refresh every 5s). Created `parseLogLine` helper to parse pino JSON lines into `{ level, msg, time }`.

### Task 16: Styling pass, docs, and the M4 exit gate

Polished the shared CSS (cards, forms, status badges, bpmn-canvas height/border, chat layout, log panel). Updated CLAUDE.md to reflect M4 built state. Ran the manual M4 exit gate against a live daemon with a temp data dir.

---

## M4 Exit Checklist (impl spec verification gates)

- [x] M4.1 — SPA served at `/` (200, "Flow Fabric"), history-route fallback, API-priority 404, all read endpoints return correct JSON (live daemon probe).
- [~] M4.2 — grill routes + re-lint loop covered by `grill-api.test.ts`; chat UI wiring unit-tested (`chat.ts`). Interactive browser chat needs `ANTHROPIC_API_KEY`, not run in the automated gate.
- [x] M4.3 — live dry run: timeline filled for all three actors with inputs/outputs/durations/cost; node markers derived by `nodeMarkers` (unit-tested). Visual overlay movement not screenshotted.
- [~] M4.4 — user task submitted over the API (204) with `usertask.submitted` event; incident resolution routes covered by `failure-ladder`/`api` tests. Browser-driven incident resolution not walked.
- [x] M4.5 — `metricsForDefinition` returned `total:1, terminated:1, successRate:1, durationsMs:[…], costPerTask:[…]` for the live run (matches FR-23).
- [x] M4.6 — `/api/scheduler` + `/api/logs` live and correctly shaped; armed-timer arm/clear proven by `scheduler.test.ts`. `SystemPage` renders them (component unit-tested via `parseLogLine`).
- [x] `pnpm build && pnpm test` green across the workspace (shared 6, web 19, server 96/5 skipped); M1–M3 suites untouched and passing.

## Build Findings (for the M5 author)

- **`@types/node` needed in `packages/web`.** The tsconfig `types: ["vitest/globals", "node"]` fails with TS2688 unless `@types/node` is a web devDep (pnpm's isolated `node_modules` doesn't hoist it). Added `@types/node@^22`.
- **bpmn-js ships types for the deep entry.** `bpmn-js/lib/NavigatedViewer` resolves its `.d.ts` under `moduleResolution: Bundler`, so no `@ts-expect-error` is needed on the import (an unused directive is itself a TS error). `viewerRef` stays `any` for the diagram-js service getters.
- **SchemaForm raw-JSON toggle is a `<button>`, not a checkbox.** The Task 13 test queries `getByRole('button', { name: /raw json/i })`; a checkbox has role `checkbox` and would fail. The escape-hatch `<textarea>` carries `aria-label="raw json"` so `getByRole('textbox')` is unambiguous in raw mode.
- **Tests that start a dry run must `await` the completion promise.** `events-vocab.test.ts` first left `host.start(...)` un-awaited; the engine finished after `afterEach` closed the store, producing an unhandled `Database.prepare` rejection (green summary, exit 1). Await completion before the store closes.
- **Live gate (automated, temp data dir):** SPA served at `/` with history-route fallback; API-priority 404 for unknown `/api/*`; log ring populated by pino (FR-25); upload → lint (`daily-loop-refined` deployable) → dry-run by definitionId records `definitionId`/`versionNo`; timeline filled all three actors; `usertask.created`/`usertask.submitted` events; run terminated via terminate-end; `metricsForDefinition` returned `terminated:1, successRate:1, durationsMs:[…]`. The init branch terminates before arming the daily timer, so `/api/scheduler` was empty in that path — armed-timer arm/clear is proven separately by `scheduler.test.ts` (loop.bpmn).
- **Not exercised here:** interactive browser walk (bpmn-js visual render, per-page console-error check) and the grill chat (needs `ANTHROPIC_API_KEY`). The grill *routes* and re-lint loop are covered by `grill-api.test.ts`; the chat UI wiring is unit-tested via `chat.ts`.

## Deferred (deliberately not in M4)

- `instances.status = 'waiting'` column — the UI derives the label (`deriveDisplayStatus`); introduce the column only if a consumer outside the UI needs it.
- OTel traces/metrics + OTLP export (FR-24) — M5.
- Diagram editing beyond grill refinement, template library (PRD §7 "Later").
- SSE auto-reconnect/backoff — `EventSource` reconnects on its own; a custom backoff is only worth it if the soak run shows dropped streams.
- Auth — localhost only, single user (PRD §8).

## Changelog

- 2026-07-19 — **Compacted post-implementation.** Removed step-by-step tasks, file-by-file diffs, code snippets, and verification commands now that M4 has shipped. Preserved Goal, Design Decisions, Critical Files summary, Build Findings, and follow-ups. Original plan recoverable via git history.
