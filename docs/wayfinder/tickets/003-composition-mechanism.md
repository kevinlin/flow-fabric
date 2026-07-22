---
id: 003
title: "How do workflows compose, and what does it cost the BPMN profile?"
type: grilling
mode: HITL
status: open
assignee: null
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
