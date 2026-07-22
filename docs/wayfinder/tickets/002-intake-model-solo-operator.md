---
id: 002
title: "What does 'work arriving' mean for a solo operator?"
type: grilling
mode: HITL
status: open
assignee: Kevin Lin
blocked-by: []
---

## Question

IndyDevDan's factory front door is a kanban queue fed by support / product / eng —
inherently multi-person. This effort stays solo-operator, so that shape does not
transfer directly.

Define the intake model:

- **Unit of work.** What is one arriving job — a request + target workspace + inputs?
  A typed ticket? A free-text ask the router must shape first?
- **Source / trigger.** Where does work come from: manual enqueue, a watched folder,
  a file drop, a timer/cron, a Slack/webhook, an "unclassified request" the router
  interprets? Which of these are in v-next vs later?
- **Queue.** Is there a queue at all, or one-at-a-time dispatch? If a queue, how is it
  expressed and observed (this feeds cross-factory observability, currently fog)?

Decide the minimum intake that makes routing meaningful without inventing a team.
Interacts with the routing-authority crux (ticket 001) and domain identity (ticket 005).

**Inherited constraint (from ticket 001 — deterministic routing):** the unit of arriving
work **carries its own type**; intake never infers it. So the "unit of work" answer must
include an operator-/source-supplied type field, and "free-text ask the router shapes
first" is viable only if the *type* still arrives explicitly — an agent may enrich other
fields, but no routing gateway ever switches on an agent-produced value.
