---
id: 004
title: "What is a 'workflow library', and how do workflows declare their I/O so the router can wire them?"
type: grilling
mode: HITL
status: open
assignee: null
blocked-by: [003]
---

## Question

Two linked decisions:

- **What "library" means.** A folder of definitions (roughly today's `DefinitionStore`)
  or a richer catalog — typed, versioned, discoverable, parameterized? Decide the least
  that makes a factory of many workflows navigable for a solo operator.
- **The contract layer.** How does a workflow advertise its purpose and its
  input/output contract so the router (ticket 001) can pick the right one and wire
  process variables between caller and callee? This is what makes composition
  (ticket 003) and routing actually connect — without it the router has nothing to match
  against and composition has no typed handoff.

Blocked by the composition mechanism (ticket 003): how workflows hand off decides what
the contract must express. Library governance (versioning, sharing) stays fog until this lands.
