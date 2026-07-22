---
id: 001
title: "Does agent-driven routing break the engine-owns-control-flow bet?"
type: grilling
mode: HITL
status: closed
assignee: Kevin Lin
blocked-by: []
---

## Question

The positioning is unambiguous: "the engine owns orchestration; the agent never
decides what runs next." An autonomous intake/router that classifies arriving work
and picks which workflow to start is an agent making a which-runs-next call — at the
factory level.

Decide the authority model and its effect on positioning. Candidate holds:

- **Meta vs intra.** "Which workflow to start" is meta-orchestration, distinct from
  "which node runs next inside a flow." The engine keeps intra-flow control; a
  classifier only proposes the entry workflow — ideally as an agent *task* inside a
  deterministic router workflow whose gateways make the actual dispatch. Bet intact.
- **Deterministic routing.** Classification stays rule/schema-driven; an agent may
  enrich the request, but a coded gateway decides. Purest fidelity to the bet, least flexible.
- **Conscious flex.** Accept that at the factory boundary an agent classifies and
  dispatches; document it as a deliberate evolution of the positioning.

Resolve which hold the direction takes, and rewrite the one-sentence positioning claim
to match. This is the crux the rest of the map hangs on.

## Resolution

**Authority hold: deterministic routing.** Work arrives pre-typed; a coded exclusive
gateway dispatches on the type field. No agent sits on the routing decision. The bet
holds literally and at every level — the engine owns which-node-next and
which-workflow-next alike.

Reasoning trail: reliable, repeatable completion is the enterprise adoption bar, and
it is satisfied identically by deterministic dispatch (both this hold and meta-vs-intra
put a coded gateway on the dispatch — the axis that actually separates them is whether
an agent produces the classification the gateway switches on). R02 confirms no surveyed
platform hands routing authority to a model. Agent classification of fuzzy input
(meta-vs-intra) was considered and rejected: the operator/source supplies the work type,
so no classifier is needed on the route. "Conscious flex" rejected outright — the one
hold R02 warns against ("orchestrator-as-god").

**Enrichment boundary (hard rule):** agents may run as intake *tasks* (summarize,
extract, validate, populate downstream variables), but **no routing gateway condition
ever reads an agent-produced value.** The type a gateway switches on is
operator-/source-supplied, never agent-inferred. This is what makes "deterministic
routing" true rather than nominal.

**Positioning rewrite** (recorded here for ticket 006 / the vision statement to carry;
PRODUCT.md is not edited under the map's plan-only mode):

- Headline: "The engine owns orchestration at every level — agents never decide what
  runs next, neither the next node nor the next workflow."
- Gloss: "Routing is deterministic: work arrives typed, coded gateways dispatch it;
  agents run inside a workflow, they never choose which one runs."

**Downstream (not decided here):**

- Ticket 002 inherits a hard constraint: the unit of arriving work carries its own type;
  intake never infers it.
- Where the routing gateway physically lives — an in-profile "intake" BPMN workflow vs.
  a host component — is a mechanism question for tickets 002/003. The bet holds either way.
