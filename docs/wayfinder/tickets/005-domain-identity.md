---
id: 005
title: "Domain identity — software factory, or general ADW factory?"
type: grilling
mode: HITL
status: open
assignee: null
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
