---
id: 002
title: "What does 'work arriving' mean for a solo operator?"
type: grilling
mode: HITL
status: closed
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

## Resolution

**Unit of work — a typed job envelope:** `{ type = definitionId + version policy
(latest-deployable / pinned), workspace (target folder, = correlation identity),
inputs (JSON for the workflow), enrichment? (agent-populated, never routed on) }`.
The source names the workflow directly (ticket 001, hold (a)); there is no
category→workflow map. The "routing layer" is thin by design — resolve version,
admit (workspace free? version deployable?), enqueue.

**Sources / triggers:**

- v-next: **manual enqueue** (exists, `POST /api/instances`) + **timer-enqueue** — a
  deterministic scheduler that fires a fresh instance on a cadence.
- Later: watched-folder drop (with a sidecar manifest carrying definitionId/version/inputs),
  then webhook/Slack (team-era).
- **Two recurrence models coexist, split by one rule:** model recurrence
  **intra-workflow** (gateway loop around a duration timer) when "run again / stop" is
  itself flow control — the flagship `rfp-daily` stays exactly as-is; use
  **timer-enqueue** when the cadence is pure operational scheduling, each run a fresh
  independent instance. This is the Kubernetes CronJob split: the schedule is a
  controller concern, not the workload's logic.

**Queue — minimal, durable:** jobs persist; FIFO dispatch; **per-workspace serialized**
(target busy → the job waits, never drops, never silent-stalls); **deduped on correlation
identity** (reusing today's one-active-per-workspace lock; R02 idempotent-intake
discipline). Different workspaces run concurrently. No priorities, no fairness.

**Bet check:** intact. Scheduler and queue are deterministic code; no agent on any
dispatch. Each instance's flow stays 100% BPMN-owned; BPMN remains source-of-truth for
flow control — only pure cadence lives in the scheduler store.

**Downstream:**

- Ticket 004: with type==workflow, the "library" loses its router-catalog role and shrinks
  toward today's `DefinitionStore` + version pinning. Annotated on that ticket.
- PRD must carry (below vision altitude): scheduler **missed-tick policy** on daemon
  downtime (catch-up / skip / fire-once), **where schedule config lives**, and a
  **cross-workspace concurrency cap**.
