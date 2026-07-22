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
- [How do workflows compose, and what does it cost the BPMN profile?](tickets/003-composition-mechanism.md) —
  **Pipeline chaining** (A finishes → B starts, no parent waits), committed for v-next; hierarchical
  call-and-return deferred to fog. Handoff is **in-BPMN, hard-named**: a terminal `scriptTask`
  enqueues the successor's envelope on 002's queue (a third enqueue source); exclusive gateways do
  conditional chains. Medium: workspace = artifacts, envelope `input` = typed params (schema shape →
  004). **Zero new BPMN elements** (reuses scriptTask + gateway + end event; one runtime item: an
  enqueue API); v1 profile exclusions stay firm. Durable for free (independent instances; double-
  enqueue covered by 002's dedup). Bet holds verbatim. No first-class pipeline object.
- [What is a 'workflow library', and how do workflows declare their I/O?](tickets/004-library-meaning-io-contracts.md) —
  **No process-level output contract** (typing lives on the receiving side; a hard-named chain's
  contract *is* B's input schema). B declares a process-level **`inputSchema` (JSON Schema)**,
  replacing flat `instanceInputs`, Ajv-validated like `formSchema`. Envelope `input` validated
  **twice** — enqueue-time (fails producer A's ladder) + B-start (durable-queue defense); shared by
  all three enqueue sources. Envelope is `{workflow, input, version?}`: **latest-deployable default
  resolved at dequeue, optional pin**. **"Library" = today's `DefinitionStore` + one `description`
  field** — no tags/search/catalog (that's governance fog). Bet intact (deterministic build +
  validate + resolve; no agent in the contract path).
- [Domain identity — software factory, or general ADW factory?](tickets/005-domain-identity.md) —
  **General ADW factory** (domain-neutral). Option 1 (code-centric) was foreclosed — 001–004 already
  built a general router (no category map) + library. Identity noun stays **control plane**; the
  **factory is a capability layer** (routing + library), not the headline, so the bet stays crisp.
  **Assert-only** generality — a code-domain exemplar is roadmap, not a v-next deliverable. **"ADW"
  redefined in place**: a Developer Workflow develops *an artifact* (code, bid, report), not
  necessarily code. Bet untouched, strengthened (authority model is domain-independent). IndyDevDan =
  generalized lead inspiration, handed to 006.

- [Synthesize the direction + vision statement (the destination artifact)](tickets/006-synthesize-direction-vision.md) —
  **Destination reached.** The locked direction lives at
  [docs/product/direction_flow-fabric.md](../product/direction_flow-fabric.md). Headline:
  "the control plane for a factory of AI Developer Workflows" (factory = workload topology,
  control plane stays the identity noun, per 005). Hybrid register: narrative positioning +
  vision, bulleted decision lock (001–005), scope boundary, PRD-must-carry, prior-art note.
  No open tickets remain; items below are the post-destination horizon, not unfinished work.

## Not yet specified

<!-- in-scope fog toward the destination; graduates into tickets as the frontier advances -->

- **Hierarchical call-and-return composition** — a workflow invoking a sub-workflow
  mid-flight, waiting, and consuming its result. Deferred by ticket 003 in favour of chaining;
  it *is* the R01 profile-expansion project (callActivity/subProcess + linter + `readProfile`
  recursion + dispatch keying + `one_active_per_workspace` rework). The vision may gesture at it
  as "where composition heads later." **Also carries the deferred typed process-level *output*
  contract** (ticket 004 declined it for hard-named chains) — structural caller/callee matching
  and discovery need it, hard-named chaining does not.
- **Parallelism + sandboxes** — isolated worktrees, concurrent attempts, racing
  (first-to-pass wins). On the horizon; the vision may gesture at it as "where this heads later."
- **Beyond one operator / machine** — team/multi-user, multiple repos, remote/cloud
  execution. On the horizon; "later."
- **Cross-factory observability** — how dashboards, incidents, and the inbox scale
  once many workflows run under one factory, now including **watching a running pipeline**
  (chaining makes multi-workflow runs concrete — ticket 003). Sharpens after routing + library shape settle.
- **Library governance** — discovery (tags/search/catalog) and sharing of workflow definitions.
  Ticket 004 landed the minimal library (`DefinitionStore` + a `description` field + latest-default
  version binding with optional pin); tags, search, and cross-machine sharing stay deferred here.
- **Second, code-domain exemplar workflow** — the artifact that would *prove* the general-ADW-factory
  claim rather than assert it. Ticket 005 chose assert-only generality; a code ADW (bug-fix, chore)
  running alongside `rfp-daily` is the demonstration that "software dev is one workflow among many"
  is real, not just stated. Roadmap, not a v-next build. Doubles as the software-factory demo the
  Zühlke audience expects.

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->

_Nothing ruled hard-out yet — the fog horizon is deliberately generous (parallelism
and team/cloud are fog, not out). Items land here only if the destination is later tightened._
