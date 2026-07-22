# Flow Fabric — Product Requirements Document

| | |
|---|---|
| Status | Draft v1 |
| Date | 2026-07-18 |
| Owner | Kevin Lin |
| Decision log | Grilling session, 2026-07-18 |

## 1. Summary

Flow Fabric is a local, web-based control plane for AI Developer Workflows (ADWs). Users model workflows as BPMN diagrams; the platform executes them end-to-end in a target workspace (a folder), coordinating the three actors of value creation: agents, humans, and deterministic code. The BPMN file is the source of truth: it defines flow control, task boundaries, inputs, expected outputs, and error handling in a form the platform can act on.

The analogy is a Kubernetes control plane: Flow Fabric owns orchestration state and scheduling decisions; the workspace is the workload it operates on. Agents never own flow control — the engine does.

## 2. Problem

Today the RFP daily routine runs as a markdown skill interpreted by a Claude Code session. This works, but:

- Flow control lives inside the agent's context. Gateways, loops, and "do not re-run" rules are prose the agent may misread. Every run re-pays tokens for control-flow reasoning that code could do for free.
- There is no execution record. No step-by-step state, no answer to "where did last night's run stop and why".
- Long-running behavior (24h timer loops, waiting on user input) depends on a session staying alive rather than on durable state.
- BPMN diagrams drawn by process owners (e.g. Signavio exports) are not executable: generic tasks, prose gateway labels, no I/O contracts.

The core bet, following the ADW / Software Factory framing (IndyDevDan, 2026): **agents plus deterministic code beats either alone**. Put the stochastic actor inside tasks and the deterministic actor in charge of the flow between them.

## 3. Goals and non-goals

### Goals (v1)

- G1. Run `rfp-daily-routine.bpmn` end-to-end, unattended, for one week on a real RFP workspace: timer loops fire, agents execute, user tasks surface, incidents escalate.
- G2. Turn a messy real-world BPMN export (Signavio) into a deployable workflow through a guided refinement session plus deterministic linting.
- G3. Answer "what is running, where is it, what did it cost, what failed" at a glance, with observability good enough to show Zühlke clients.

### Non-goals (v1)

- Multi-user access, auth, shared deployments (Zühlke team tool is a later phase).
- Non-Claude agent runtimes (no pluggable runner abstraction yet).
- Executing multi-week human-only processes (the interview process is an import/refinement test case, not an execution target).
- Cloud or remote execution; v1 is one machine, local browser.

### Success criteria

- rfp-daily completes ≥7 consecutive daily cycles with zero silent stalls: every halt is either a modeled end event or a surfaced incident.
- interview-process.bpmn imports, survives the grilling session, and passes the linter, without the platform needing to execute it.
- Every executed step is visible in the timeline with inputs, outputs, duration, and token cost.

## 4. Users

V1 has one user: an engineer (the author) running their own ADWs locally, 24/7. The product must still be presentable: it doubles as a demo of agentic-SDLC practice in Zühlke client conversations. Design and copy quality matter; multi-tenancy does not.

## 5. Core concepts

| Concept | Definition |
|---|---|
| Workflow definition | A BPMN 2.0 file conforming to the Flow Fabric profile. Source of truth. |
| Flow Fabric profile | Conventions that make BPMN agent-actionable: task types map to actors; `flowfabric` extension elements carry task contracts. |
| Actor | Who executes a task: agent (Claude), user (human), or code (deterministic script). |
| Workspace | The target folder a workflow instance operates on. Pure workload; the platform never stores its own state there. |
| Instance | One running execution of a definition against a workspace. |
| Process variables | Typed key-value state owned by the engine; the only channel through which tasks exchange information. |
| Incident | A paused token awaiting human resolution after unhandled failure. |
| Event log | Append-only record of every state transition of every instance. |

## 6. Requirements

### 6.1 Workflow intake and refinement

- FR-1. Users upload any BPMN 2.0 file. The platform renders it (bpmn-js) even when it is not yet executable.
- FR-2. A refinement ("grilling") session runs as a chat panel beside the rendered diagram. The grill agent walks the diagram node by node and interrogates the user to:
  - assign each task an actor by rewriting its task type (see 6.2);
  - write the task contract into `flowfabric` extension elements: agent prompt, allowed tools, boundaries, input variables, expected output schema;
  - convert prose gateway labels ("Has deadline passed?") into conditions evaluable against process variables;
  - replace instruction-bearing labels ("Task Ends Here Do No Re-Run") with proper BPMN semantics (terminate end events, loop conditions).
- FR-3. A deterministic linter (code, not an agent) gates deployment. A definition is deployable only when: every gateway path has an evaluable condition, every agent task has a prompt and output schema, every code task has a command, no orphan nodes, all referenced variables are produced upstream or declared as instance inputs.
- FR-4. Refinement output is a new version of the BPMN file. Definitions are versioned; running instances stay pinned to the version they started on.

### 6.2 Flow Fabric BPMN profile

- FR-5. Actor mapping uses standard BPMN task types, so any BPMN editor can read the files:
  - `userTask` → human,
  - `scriptTask` → deterministic code,
  - `serviceTask` → agent (with `flowfabric` extension: prompt, tools, boundaries, output schema, retry count).
  - Lanes remain documentation only; they never affect execution.
- FR-6. Supported elements in v1: start/end events (including terminate), exclusive gateways, the three task types, timer intermediate catch events (duration and cycle, e.g. `R/PT24H`), and error boundary events. The linter rejects anything else with a clear message.

### 6.3 Execution engine

- FR-7. The platform embeds `bpmn-engine` (Node.js). The engine owns tokens, gateway evaluation, timers, and joins. No agent ever decides which node runs next.
- FR-8. Gateway conditions evaluate against process variables only, never against free text or agent judgment.
- FR-9. Engine state persists after every transition. A platform restart resumes all instances from persisted state, including in-flight timers. This is what makes 24/7 operation and multi-day timer loops safe.
- FR-10. One active instance per workspace. Parallel instances are allowed across different workspaces.

### 6.4 Task execution — the three actors

- FR-11. **Agent tasks**: each `serviceTask` spawns a fresh headless Claude session (Claude Agent SDK) with cwd set to the workspace. The session receives the task prompt, boundaries, and declared input variables; it must return JSON matching the declared output schema. Validated output merges into process variables. Sessions are stateless between tasks; all context handoff is explicit via variables.
- FR-12. **Code tasks**: each `scriptTask` runs a declared command/script in the workspace with input variables in its environment or stdin; its structured output merges into process variables.
- FR-13. **User tasks**: each `userTask` renders in a web inbox as a form derived from its declared input schema. Submitting the form writes the variables and resumes the token. V1 ships exactly one push notification channel (e.g. macOS notification or Slack webhook) so pending tasks and incidents don't rely on polling.
- FR-14. Every task execution records: start/end time, actor, resolved inputs, outputs, duration, and, for agent tasks, full transcript reference and token usage/cost.

### 6.5 State and persistence

- FR-15. All control-plane state lives in platform-owned storage (SQLite plus append-only event log) under the platform's data directory. Nothing is written to the workspace except what tasks themselves produce.
- FR-16. The event log is the source of history: every instance state transition is appended, enabling timeline replay and audit.

### 6.6 Failure handling

- FR-17. Task success is defined by contract: output validates against the declared schema (agent, code) or the form is submitted (user). Anything else is failure, including SDK errors, timeouts, and non-conforming output.
- FR-18. Failure escalation is layered:
  1. automatic retry up to the task's configured count;
  2. if the diagram models an error boundary event on the task, route the token there;
  3. otherwise raise an incident: the token pauses, the incident appears in the inbox and fires the notification channel; the user resolves it with retry, skip (with manually supplied output), or abort instance.
- FR-19. The platform never silently stalls and never lets an agent improvise recovery outside the diagram.

### 6.7 Observability

- FR-20. **Live diagram view**: current token position(s) of each instance overlaid on the BPMN diagram, with visited path and per-node status.
- FR-21. **Instance timeline**: chronological step list with inputs, outputs, durations, agent transcript links, and per-step token cost.
- FR-22. **Incident list**: all open incidents across instances with one-click resolution actions.
- FR-23. **Metrics dashboards**: per-definition success rate, run duration distribution, token cost per run and per task, incident frequency, from day one.
- FR-24. **OpenTelemetry export**: traces (instance → task spans) and metrics exportable to any OTel collector, so the platform plugs into existing observability stacks when showcased.
- FR-25. Platform itself is operable: health endpoint, structured platform logs, and visible scheduler state (next timer firings).

## 7. V1 scope summary

| Area | In v1 | Later |
|---|---|---|
| Intake | Upload, render, grill, lint, version | Diagram editing beyond refinement, template library |
| Profile | 3 task types, exclusive gateway, timers, error boundaries, terminate | Parallel/event gateways, message events, subprocesses, multi-instance |
| Engine | bpmn-engine, durable resume, 1 instance/workspace | Concurrent instances per workspace, distributed execution |
| Agents | Claude Agent SDK, fresh session per task | Pluggable runners (Codex, Gemini), long-lived sessions |
| Users | Inbox + 1 notifier, single user | Multi-user, roles matching lanes, auth |
| Observability | Live diagram, timeline, incidents, dashboards, OTel | Alerting rules, SLOs, cost budgets |
| Flagship | rfp-daily executes; interview imports/lints | Interview process executable (multi-week human flows) |

## 8. Architecture assumptions

- TypeScript/Node.js backend; `bpmn-engine` embedded; SQLite for state; append-only event table.
- React frontend with `bpmn-js` for rendering/overlay; local web app served by the platform process.
- Claude Agent SDK for agent tasks; single long-running platform daemon hosts engine, scheduler, web server.
- No auth in v1 (localhost only).

## 9. Risks and open questions

- **bpmn-engine fit**: resume-from-state and timer persistence must be validated against multi-day cycles early (spike in week 1). Fallback is the custom-interpreter path rejected for v1; that path is expensive, so de-risk early.
- **Grilling quality**: the refinement session is itself an agent workflow; a bad grill produces deployable-but-wrong definitions. The linter catches structure, not intent. Mitigation: dry-run mode (execute with agents replaced by echo stubs) before first real run.
- **Signavio round-trip**: rewriting task types and extensions must not corrupt diagram layout (DI). Needs a test with both sample files.
- **Cost of fresh sessions**: per-task sessions re-pay workspace discovery each time. If rfp-daily cost is excessive, consider shared read-only context priming, without reintroducing implicit state.
- **Schema-from-BPMN forms**: user task form generation assumes JSON-schema-like input declarations in extensions; complex inputs (files, tables) may need escape hatches.

## 10. References

- `docs/product/forget-loop-engineering-indydevdan.md` — ADW / Software Factory framing, three actors, design principles.
- `Input/bpmn/rfp-daily-routine.bpmn` — flagship workflow (Signavio export, to be refined into the profile).
- `Input/bpmn/interview-process.bpmn` — intake/refinement generality test case.
