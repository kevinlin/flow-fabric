# Factory intake: durable job queue, timer-enqueue scheduler, pipeline chaining, typed workflow inputs

Spec for the v-next build implied by the locked direction ([direction_flow-fabric.md](direction_flow-fabric.md), wayfinder tickets 001–005). Tracked as [issue #1](https://github.com/kevinlin/flow-fabric/issues/1) (`ready-for-agent`). Everything here is deterministic code: coded gateways, a deterministic queue and scheduler, Ajv validation, deterministic version resolution. No agent sits on any routing or composition decision.

## Problem Statement

Flow Fabric today runs one workflow at a time, started by hand. A solo operator who wants a factory of specialized workflows has no intake: work cannot arrive on a cadence, one workflow cannot hand off to the next, and starting a run means knowing the exact definition and typing its inputs from memory. The flagship `rfp-daily` models its own recurrence as a gateway loop because there is no scheduler; a bid audit that should flow into submission prep needs a human to notice the audit finished and start the next run by hand. There is no queue, so two arrivals for the same workspace are a 409, not a wait. And a workflow's input contract is a flat name/type list that cannot express required fields, enums, or nested shapes, so nothing validates what crosses into a run.

## Solution

Give the daemon a typed intake path with three sources feeding one durable queue.

Work arrives as a typed job envelope, `{ workflow, workspace, input, version?, enrichment? }`. The source names the workflow directly: no category map, no agent inference. The envelope lands on a minimal durable queue: FIFO, serialized per workspace (busy target → the job waits, never drops), deduplicated so a crash-window double-enqueue is a no-op, concurrent across workspaces under a global cap.

Three sources share that one enqueue path:

1. **Manual** — the operator enqueues from the UI or API, with the target workflow's input schema rendered as a form.
2. **Timer** — a deterministic scheduler fires a fresh envelope on a cadence. Schedule config is controller state, not workload logic (the Kubernetes CronJob split); the flagship's intra-workflow loop stays untouched because there "run again?" is flow control.
3. **Chain** — a terminal `scriptTask` in workflow A enqueues workflow B's envelope. The chain topology lives in the BPMN source of truth; conditional chains use exclusive gateways; the workspace carries the work product between runs; zero new BPMN elements.

Typing lives on the receiving side: each workflow declares a process-level `inputSchema` (JSON Schema, replacing the flat `instanceInputs` list). The envelope `input` is Ajv-validated twice: at enqueue (rejects bad envelopes at the source; a chain's bad envelope fails the producer's failure ladder) and at dequeue/start (durable-queue defense). Version resolution is deterministic: latest-deployable at dequeue by default, optional exact pin. The library gains one `description` field so a factory of many definitions stays browsable.

## User Stories

1. As a solo operator, I want to enqueue a typed job (workflow, workspace, input) via the API or UI, so that all work enters the factory through one intake path.
2. As a solo operator, I want the queue persisted in control-plane state, so that enqueued work survives daemon restarts and crashes.
3. As a solo operator, I want a job targeting a busy workspace to wait its turn rather than be rejected, so that the workspace lock never drops work.
4. As a solo operator, I want jobs on different workspaces to run concurrently, so that one long run does not block unrelated work.
5. As a solo operator, I want per-workspace FIFO order, so that runs on a workspace happen in the order they were enqueued.
6. As a solo operator, I want enqueueing an envelope identical to one already pending to be a no-op, so that a crash between a chain's enqueue task and its end event cannot produce a duplicate run.
7. As a solo operator, I want a schedule that enqueues a named workflow on a cadence, so that daily routines fire without me touching anything.
8. As a solo operator, I want to create, edit, pause, and delete schedules through the API, so that cadence is controller configuration rather than workload logic.
9. As a solo operator, I want ticks missed during daemon downtime coalesced into a single fire at boot, so that a closed laptop neither skips the daily routine nor replays a week of them.
10. As a solo operator, I want a global cap on concurrently running instances, so that a busy queue cannot overload my machine or my API budget.
11. As a workflow author, I want the intra-workflow recurrence loop to keep working exactly as it does, so that the flagship `rfp-daily` needs no change.
12. As a workflow author, I want a terminal `scriptTask`'s code contract to enqueue a successor workflow's envelope, so that pipelines chain without any new BPMN element.
13. As a workflow author, I want conditional chains expressed with exclusive gateways routing to different enqueue tasks, so that "audit passed → prep submission, else → remediate" is deterministic and visible in the diagram.
14. As a workflow author, I want the successor to read the predecessor's artifacts from the shared workspace, so that the workspace carries the work product and the envelope carries only small typed params.
15. As a workflow author, I want to declare a process-level `inputSchema` as JSON Schema in the BPMN extension elements, so that my workflow's input contract lives in the source of truth and can express required fields, enums, and nested shapes.
16. As a workflow author, I want every enqueue validated against the target workflow's `inputSchema`, so that a malformed envelope is rejected before it enters the durable queue.
17. As a workflow author, I want a chain's rejected envelope to fail the producer's terminal `scriptTask` into the existing failure ladder, so that I get retry, boundary-error, and incident semantics on bad handoffs.
18. As a solo operator, I want the envelope re-validated at dequeue before the instance starts, so that a schema redeployed after enqueue or a hand-edited queue row cannot crash-loop a workflow.
19. As a solo operator, I want a job with no version pin to resolve to the latest deployable version at dequeue, so that my local edit/redeploy loop picks up fixes without touching pending jobs.
20. As a workflow author, I want an optional exact version pin on the envelope, so that a released chain or a regression repro runs a reproducible version.
21. As a solo operator, I want a job that cannot start (failed validation, no deployable version, missing pin target) to land in a visible failed state with a reason, so that nothing silently stalls.
22. As a solo operator, I want each definition to carry a one-line description, so that a library of many workflows is browsable by purpose, not filename.
23. As a solo operator, I want to list the queue (pending, running, done, and failed jobs, each with its source: manual, timer, or chain), so that I can trust what is in flight.
24. As a solo operator, I want queue and schedule changes on the existing SSE stream, so that the UI reflects intake state without polling.
25. As a solo operator, I want each job linked to the instance it started, so that I can trace intake → run → outcome end to end.
26. As a solo operator, I want the manual-enqueue form rendered from the target workflow's `inputSchema`, so that typed input entry reuses the existing schema-form machinery.
27. As a solo operator, I want an optional `enrichment` field that agents may populate but no gateway ever reads, so that intake agents can add context without gaining routing authority.
28. As a solo operator, I want dry-run jobs to flow through the same queue and validation, so that I can rehearse a chain end to end without live agent calls.
29. As a workflow author, I want the linter and BPMN profile unchanged by chaining, so that every existing deployable definition stays deployable.
30. As a solo operator, I want no model anywhere in enqueue, dispatch, version resolution, or validation, so that the factory's routing is repeatable and auditable.

## Implementation Decisions

**Envelope.** One arriving job is:

```
{
  workflow: string,        // definition id — source names it directly, no category map
  workspace: string,       // target folder; the correlation identity
  input: object,           // typed params, validated against the target's inputSchema
  version?: number,        // omit → latest-deployable resolved at dequeue; set → exact pin
  enrichment?: object      // agent-populated context; never read by any gateway or dispatch decision
}
```

(Shape consolidated from wayfinder tickets 002 and 004.)

**Queue.** A new durable queue module in the server, persisted in the existing control-plane SQLite alongside the instance store. Semantics: FIFO per workspace; per-workspace serialization reuses the one-active-per-workspace lock as the gate (busy → job stays pending, dispatch retries when the workspace frees); different workspaces dispatch concurrently subject to a global concurrency cap (configurable, modest default). Dedup: an enqueue whose envelope is identical (workflow, workspace, input, version) to an already-pending job is a no-op returning the existing job. This exactly covers the chain double-enqueue crash window; distinct envelopes are never dropped. Jobs carry a status lifecycle (pending → starting → running → done/failed) and a link to the instance they started.

**Enqueue API.** One enqueue operation on the engine host, exposed three ways: an HTTP endpoint (manual source, and the documented intake path), the scheduler (timer source), and a call reachable from a `scriptTask` code-contract runtime (chain source). All three hit the same validation gate and dedup; the gate is queue-level, not per-source. The existing direct-start endpoint's fate (thin wrapper over enqueue vs. retained bypass) is an implementation choice; the queue is the documented path.

**Scheduler.** A deterministic timer-enqueue scheduler. Schedule config lives in control-plane SQLite (not in BPMN, not in the workspace: schedule is a controller concern), managed via CRUD API: workflow, workspace, input, cadence, enabled flag. Missed-tick policy is **fire-once**: on boot, any number of ticks missed during downtime coalesce into one enqueue (dedup absorbs races). Recurrence rule: intra-workflow gateway loops remain the model when "run again?" is flow control; timer-enqueue is for pure cadence, each tick a fresh independent instance.

**Chaining.** No first-class pipeline object, no new BPMN elements, no linter changes, no profile changes. A chain is a terminal `scriptTask` whose code contract calls the enqueue operation with the successor's envelope, hard-naming the successor. Conditional chains are exclusive gateways routing to different enqueue tasks. An enqueue rejection (validation failure, unknown workflow) throws inside the `scriptTask`, entering the producer's existing failure ladder. Durability needs no new mechanism: each workflow is an independent flat instance; the double-enqueue window is covered by queue dedup plus the engine skipping completed activities on recover.

**Input contract.** The flat `instanceInputs` name/type list is replaced by a process-level `inputSchema` (JSON Schema) in the flowfabric extension namespace, read into the process profile and validated with the existing Ajv machinery (same pattern as `formSchema`). Validation runs twice: at enqueue (the primary gate, rejecting before the row enters the durable queue) and at dequeue/start (the defense: the target may have redeployed a changed schema since enqueue, and a hand-inserted row must fail visibly, not crash-loop). A workflow with no `inputSchema` accepts any input. Timer schedules validate their stored input at create/update time as well, so a schema drift surfaces as a visible scheduler error at the next tick, not a silent stall.

**Version resolution.** Deterministic, at dequeue: no pin → latest deployable version; pin → that exact version. A pin to a missing or non-deployable version fails the job into its visible failed state. Long-queued jobs run newest-at-dequeue by design (accepted; near-moot at solo FIFO depth).

**Library.** The definition store gains a nullable `description` column, settable via the definitions API and shown in the definitions list. Nothing else: no tags, search, or catalog.

**Observability, minimal.** New SSE event kinds for job and schedule lifecycle on the existing event stream, plus read endpoints for the queue and schedules. Enough that the UI never shows a stalled surface; dashboards for watching a running pipeline stay out of scope.

## Testing Decisions

Good tests here assert external behavior only: API responses, SSE events, job/instance states visible through read endpoints, and artifacts on the workspace — never queue-table internals or module private state.

**Primary seam (existing): the composition root plus HTTP inject.** The daemon graph built with a temp data dir and inert defaults (stub runners, no-op notifier) exercises the whole feature: enqueue via API → job waits/dedups/serializes → instance starts → chain fixture's terminal task enqueues the successor → successor runs after the predecessor is terminal. Prior art: the existing compose, API, and dry-run end-to-end suites, and the loop test's fixture-driven style. Chain tests use a two-definition BPMN fixture pair (A ends in an enqueue `scriptTask`; B declares an `inputSchema`).

**One new seam: an injectable clock for the scheduler**, passed through the composition root with a real-clock default (same inert-default pattern as runners and notifier). Missed-tick (fire-once coalescing) and cadence tests drive the fake clock; no real-timer sleeps, avoiding the existing parallel-run flakiness of real-timer tests.

Restart durability tests follow the existing resume-suite pattern: build daemon, enqueue, close, rebuild on the same data dir, assert pending jobs dispatch and missed ticks coalesce.

Modules under test: queue (order, serialization, dedup, cap), scheduler (cadence, missed-tick, CRUD, validation-at-save), enqueue gate (all three sources, both validation points), version resolution, chain handoff, profile read of `inputSchema`, definition description, SSE vocabulary additions. Web: the manual-enqueue form rendering `inputSchema` reuses the existing schema-form component tests as prior art.

## Out of Scope

- **Hierarchical call-and-return composition** (callActivity/subProcess, profile expansion, typed process-level *output* contracts) — deferred fog; chaining is the committed mechanism.
- **Additional intake sources**: watched folders, webhooks, Slack. Manual, timer, and chain only.
- **Parallelism and sandboxes**: worktrees, concurrent attempts, racing.
- **Multi-user, multi-machine, remote execution.**
- **Cross-factory observability**: pipeline-watching UI, factory dashboards, incident scaling. Only the minimal queue/schedule reads and SSE events above.
- **Library governance**: tags, search, catalog, sharing. Description only.
- **A second code-domain exemplar workflow** — roadmap, not this build.
- **Queue priorities and fairness policies** — FIFO only.

## Further Notes

- The core bet is the acceptance frame for every piece: the engine owns orchestration at every level; agents decide neither the next node nor the next workflow; the workspace is the workload; BPMN is the source of truth. Any review finding an agent-produced value influencing enqueue, dispatch, or version resolution is a defect.
- Replacing `instanceInputs` touches the shared profile types, the moddle descriptor, and the two local BPMN files (untracked); the flagship's start form in the web UI moves from the flat list to the schema form.
- Design-principle tie-ins from the product doc: "never silently stall" motivates the visible job-failed state and start-time revalidation; "show engine truth" motivates jobs linking to instances and SSE lifecycle events.
- Rationale trails live in the wayfinder tickets (002 intake, 003 composition, 004 contracts) — rejected options and edge cases are recorded there, not repeated here.
