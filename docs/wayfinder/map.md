---
labels: [wayfinder:map]
title: "Flow Fabric direction — how far toward an autonomous factory of composable workflows"
---

# Wayfinder map — Flow Fabric direction

## Destination

A 1–2 page locked direction and vision statement deciding how far Flow Fabric
reaches from "disciplined single-workflow control plane" toward an **autonomous
factory of composable workflows**, for a solo operator running locally. It
resolves two linked moves — (a) an intake/routing layer that routes pre-typed arriving
work to the right workflow, and (b) a library of specialized,
composable workflows — while either defending or consciously revising the core
bet: the engine owns control flow, the agent never decides what runs next, and
BPMN is the source of truth. Decisions only; a future PRD is built from it.

## Notes

- **Domain**: Flow Fabric product direction. Orient every session to
  [PRODUCT.md](../../PRODUCT.md), [the PRD](../product/prd_flow-fabric.md), and
  [the IndyDevDan ADW/Software-Factory notes](../product/forget-loop-engineering-indydevdan.md)
  before deciding.
- **Skills**: grilling + domain-modeling for grilling tickets; /research (subagent)
  for research tickets; prototype only if a "how should it look / behave" question surfaces.
- **Mode**: plan-only. Produce decisions, not build. The vision statement is the
  single deliverable; the synthesis ticket assembles it.
- **Core bet to defend or consciously revise**: "the engine owns orchestration; the
  agent never decides what runs next; the workspace is the workload." Any decision
  touching routing or composition must state its effect on this bet.
- **Prose**: de-slop (declaude); no decorative emoji.

## Decisions so far

<!-- one line per closed ticket: gist + link -->

- [Research — bpmn-engine composition capability](tickets/R01-research-bpmn-engine-composition.md) —
  callActivity + subProcess + multi-instance all round-trip durably (timers fire at original
  deadline), but only within one `<definitions>` source; spawning a separate/versioned definition
  needs host-level orchestration. Adopting composition is a profile-expansion project (linter,
  `readProfile` recursion, dispatch node-id keying, workspace lock all block it today).
- [Research — prior-art platforms](tickets/R02-research-prior-art-platforms.md) —
  across 7 platforms, routing authority is never given to a model directly (deterministic artifact
  always dispatches); intake dedupes on a correlation identity; call activity is the composition
  median; typed JSON-Schema I/O + version pinning + tagged catalog is the library template.
- [Does agent-driven routing break the engine-owns-control-flow bet?](tickets/001-routing-authority-vs-bet.md) —
  No. Direction takes **deterministic routing**: work arrives pre-typed, a coded gateway dispatches
  on the type field, no agent on the routing decision. Agents may run as intake tasks but no gateway
  routes on agent output. Positioning strengthens to "the engine owns orchestration at every level —
  agents decide neither the next node nor the next workflow."
- [What does 'work arriving' mean for a solo operator?](tickets/002-intake-model-solo-operator.md) —
  A typed job envelope (source names the workflow directly — type==workflow, no category map).
  v-next sources: manual enqueue + **timer-enqueue**; two recurrence models coexist (intra-workflow
  loop when "run again?" is flow control — flagship stays as-is; timer-enqueue for pure cadence).
  A **minimal durable queue**: FIFO, per-workspace serialized (busy → wait, never drop), deduped on
  correlation identity. Scheduler + queue are deterministic code — bet intact.

## Not yet specified

<!-- in-scope fog toward the destination; graduates into tickets as the frontier advances -->

- **Parallelism + sandboxes** — isolated worktrees, concurrent attempts, racing
  (first-to-pass wins). On the horizon; the vision may gesture at it as "where this heads later."
- **Beyond one operator / machine** — team/multi-user, multiple repos, remote/cloud
  execution. On the horizon; "later."
- **Cross-factory observability** — how dashboards, incidents, and the inbox scale
  once many workflows run under one factory. Sharpens after routing + library shape settle.
- **Library governance** — versioning, discovery, and sharing of workflow definitions.
  Sharpens after "what a library means" resolves.

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->

_Nothing ruled hard-out yet — the fog horizon is deliberately generous (parallelism
and team/cloud are fog, not out). Items land here only if the destination is later tightened._
