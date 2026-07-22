---
id: 006
title: "Synthesize the direction + vision statement (the destination artifact)"
type: grilling
mode: HITL
status: closed
assignee: Kevin Lin
blocked-by: [001, 002, 003, 004, 005, R02]
---

## Question

Assemble the destination: a 1–2 page locked direction and vision statement.

Decide the headline framing: does **"Software Factory"** become Flow Fabric's product
frame, or does it stay "the control plane for AI workflows" with a factory *mode/layer*
on top? Then fold in the resolved decisions:

- authority model (ticket 001),
- intake (ticket 002),
- composition (ticket 003),
- library + contracts (ticket 004),
- domain identity (ticket 005).

State the revised positioning, the scope boundary (parallelism and team/cloud stay fog),
and what a future PRD must carry. Keep it prior-art-aware (ticket R02). De-slop the prose.

This ticket produces the deliverable the whole map exists to reach — take it last,
once everything blocking it is closed.

## Resolution

**Deliverable: [docs/product/direction_flow-fabric.md](../../product/direction_flow-fabric.md)** —
the locked 1–2 page direction and vision statement. The map's destination is reached; no
open tickets remain.

Two authoring decisions were put to the operator (the substance was already locked by
001–005):

- **Headline framing — "the control plane for a factory of AI Developer Workflows."**
  "Software Factory" does not become the product frame; per ticket 005 the identity noun
  stays *control plane*, and "factory" appears in the headline only as the workload
  topology the control plane governs. Operator confirmed this over the more conservative
  option (factory kept out of the headline entirely) and the factory-led option (which
  would have reopened 005).
- **Register — hybrid.** Short narrative top (positioning + one-paragraph vision), then a
  bulleted decision lock (001–005), the core-bet restatement, scope boundary (fog stays
  fog), what a future PRD must carry, and a prior-art note (R02). Chosen over a dry
  decision record and a full narrative manifesto.

The document folds in all five locked decisions verbatim-in-meaning: deterministic
routing (001), the typed job envelope + durable queue (002), pipeline chaining at zero
profile cost (003), receiving-side contracts + minimal library (004), and the general-ADW
identity with "ADW" redefined in place (005). Prose de-slopped via the declaude loop
(2 passes; em-dash density and mid-bullet bold cut, hedge on "arguably strengthened"
committed).

PRODUCT.md / PRD edits remain out of this map's plan-only mode — the direction doc is
the input a future PRD session builds from.
