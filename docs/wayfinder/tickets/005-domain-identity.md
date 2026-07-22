---
id: 005
title: "Domain identity — software factory, or general ADW factory?"
type: grilling
mode: HITL
status: closed
assignee: Kevin Lin
blocked-by: []
---

## Question

IndyDevDan's Software Factory builds software: feature / bug / chore / hotfix workflows
over a codebase. Flow Fabric's flagship (`rfp-daily`) is business-process governance,
not code. So the inspiration and the flagship point at different domains.

Decide the domain the direction commits to:

- **Software-development factory** — embrace the IndyDevDan frame; workflows are
  codebase-centric; the router classifies engineering work.
- **General ADW factory** — software dev is one application among business-ops routines
  (RFP governance, ops, research); the router and library are domain-agnostic.
- **General platform, software-factory as lead demo** — stay general under the hood,
  but position and demo around the software factory because it lands with the Zühlke audience.

This choice shapes what the router classifies (ticket 002), what the library holds
(ticket 004), and the headline framing (ticket 006).

## Resolution

**General ADW factory** — domain-neutral identity. Software development is one workflow
among business-ops routines (RFP governance, ops, research), not the domain.

Option 1 (software-development factory) was foreclosed, not chosen against: tickets
001–004 already committed general mechanisms — the router (002) is a coded gateway on a
`type` field with no category map, the library (004) is `DefinitionStore` + a free-text
`description`. Nothing built classifies feature/bug/chore/hotfix. Committing to a
code-centric factory would mean *revising* locked decisions to narrow a general router into
a code-work classifier. The live fork was general (2) vs. general-with-software-demo-skin
(3); (2) chosen as the honest description of what exists.

Five locked decisions:

1. **Identity noun stays "control plane."** Flow Fabric remains "the control plane for AI
   Developer Workflows." The *factory* (intake routing + composable library, built in
   002/003/004) is a **capability layer**, not the identity noun. Rationale: the core bet is
   a control-plane/authority claim; "factory" describes workload topology. Promoting
   "factory" to the headline would blur the bet. IndyDevDan's factory metaphor survives as
   the structure, subordinated to the control-plane identity.

2. **Assert-only generality.** The vision states the factory is domain-neutral; it does
   **not** require a second exemplar as a v-next deliverable. A code-domain ADW alongside
   `rfp-daily` is roadmap/fog, not a build commitment. (Rejected the stronger "≥2 workflows
   across two domains as the acceptance bar" — it would pull the composition roadmap into
   v-next.)

3. **"ADW" redefined in place.** Keep the acronym; restate the "D": a **Developer Workflow
   develops an artifact — code, a bid, a report — not necessarily code.** `rfp-daily`
   develops a governed bid. One sentence in the vision removes the misnomer that "Developer"
   quietly re-narrows the identity back to software. (Rejected a repo-wide rename to
   "AI Workflow" — execution churn this plan-only map isn't chartering.)

4. **Bet untouched — arguably strengthened.** Domain identity is orthogonal to
   "engine owns orchestration; agent never decides what runs next." The authority model is
   domain-independent; a general factory over deterministic routing *demonstrates* the
   control-plane claim holds regardless of whether the workload is code or a bid. No agent
   added to any routing or composition decision.

5. **IndyDevDan = generalized lead inspiration, handed to ticket 006.** His code-specific
   Software Factory becomes one instance of Flow Fabric's domain-neutral factory. 006 (headline
   framing) inherits this stance — lead inspiration, consciously widened — so it needn't
   re-litigate domain.

**Fog graduated:** the second, code-domain exemplar workflow — the artifact that would
*prove* generality rather than assert it — added to the map's "Not yet specified."
