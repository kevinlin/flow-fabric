---
id: 003
title: "How do workflows compose, and what does it cost the BPMN profile?"
type: grilling
mode: HITL
status: closed
assignee: wayfinder-session
blocked-by: [R01]
---

## Question

Decide the mechanism by which one workflow invokes or hands off to another:

- **BPMN call activity / subprocess** — nest a definition inside another.
- **Start a fresh sub-instance** from within a running instance (a service/script task
  that calls the engine host to launch another definition).
- **Chaining** — one instance completes and routes to the next.

The v1 profile explicitly excludes subprocesses and parallel/event gateways. State
which mechanism the direction commits to, whether it requires expanding the profile
(and which elements), and — load-bearing — how it preserves durable resume
(`getState`/`recover`) and originally-scheduled timers across the composition boundary,
and keeps control flow engine-owned.

Blocked by the bpmn-engine capability research (ticket R01): the choice depends on
what the engine actually supports for sub-instances and multi-instance.

## Resolution

**Mechanism: pipeline chaining via the intake queue, committed for v-next.** A workflow
runs to completion, then the next one starts — a sequence of whole workflows, no parent
waiting. Hierarchical call-and-return (a workflow invoking a sub-workflow mid-flight and
consuming its result) is deferred to fog. Chosen over call-and-return because chaining
builds entirely on decided pieces (the 002 queue) with **zero BPMN profile expansion**,
while call-and-return has no engine primitive for separate/versioned definitions (R01) and
would force the whole profile-expansion project.

- **How the chain is expressed — in-BPMN, hard-named.** A workflow's terminal path runs a
  `scriptTask` (deterministic code, already in the profile) whose code contract enqueues the
  successor's job envelope `{workflow, input}` onto 002's queue. The successor is **named
  directly** in the contract (no indirection table — forced by 002's "source names the
  workflow directly, no category map"). Conditional chains ("tests pass → deploy, else →
  fix") use an **exclusive gateway** (already in the profile, JS conditions, survives resume)
  to route to the right enqueue-task. The whole chain topology lives in the `.bpmn` source of
  truth, inspectable in the diagram — not in a side manifest (a manifest would be a second
  flow-control artifact outside the source of truth, weakening the bet).

- **Handoff medium — workspace for artifacts, envelope for typed params.** A and B run on the
  same workspace (002's queue is per-workspace serialized; B waits until A is terminal, then
  picks up). The **workspace carries the work product** (spec, diff, audit report) — this is
  the "workspace is the workload" bet: B reads what A left on disk. The **job-envelope `input`
  carries the small typed params** B needs to start, validated against B's input contract. The
  precise input-schema shape is **ticket 004's** turf (the contract layer); 003 commits only
  the medium.

- **Profile cost — zero new BPMN elements.** Reuses `scriptTask` + exclusive gateway + normal
  end event. No linter change (no FF001 rework), no `readProfile` recursion, no dispatch
  re-keying, no `one_active_per_workspace` rework — chaining *respects* the workspace lock (B
  waits for A) instead of fighting it. The v1 exclusions (subprocess, parallel/event gateways)
  stay firm and are **vindicated**: chaining deliberately avoids the nesting that would force
  expansion. One **runtime** build item (not a profile change): an enqueue-job API on the
  engine-host reachable from a code contract; the 002 queue shape is unchanged, it just gains
  an in-instance caller. The R01 expansion project (callActivity/subProcess + linter +
  `readProfile` recursion + dispatch keying + workspace-lock rework) **is** the deferred
  hierarchical-composition work — the conscious price of that later capability, not paid now.

- **Durability — no composition boundary inside a state blob.** Each workflow is an independent
  single-flat-process instance, already durable via `getState`/`recover` with timers firing at
  their original deadline (the M1 bet, untouched). No nesting → no new cross-boundary resume or
  timer logic. The one subtlety, **double-enqueue** (daemon crashes after A's enqueue-scriptTask
  runs but before A is terminal), is handled by **002's correlation-identity dedup** (a
  re-enqueue of the same job is a queue no-op) plus the engine skipping already-completed
  activities on `recover`. No new mechanism.

- **Bet — intact, verbatim.** Enqueue-by-deterministic-code (scriptTask) + dispatch-by-
  deterministic-queue. No agent, no gateway on agent output. 001's positioning holds word for
  word — "the engine owns orchestration at every level; agents decide neither the next node nor
  the next workflow." Chaining is the concrete proof of the *next-workflow* clause.

- **Scope guards.** Chaining is a **third enqueue source** on 002's queue, peer to manual-enqueue
  and timer-enqueue (same FIFO, serialization, dedup — no separate path). **No first-class
  "pipeline" object** in v-next: a pipeline (A→B→C) is emergent from hard-named chains, not a
  stored entity with its own state/UI. "How do you *watch* a running pipeline" stays in the
  cross-factory-observability fog.

**Feeds 004** (now unblocked): the contract layer must express B's typed `input` schema (the
envelope handoff) and A's typed output — re-scoped around composition handoff, not router
matching. **Hierarchical call-and-return** graduates to the map's Not-yet-specified fog as
"where composition heads later."
