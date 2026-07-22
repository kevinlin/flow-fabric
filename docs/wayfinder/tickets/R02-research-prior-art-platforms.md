---
id: R02
title: "Research — how comparable platforms model routing, composition, and a workflow library"
type: research
mode: AFK
status: closed
assignee: wayfinder-session
blocked-by: []
---

## Question

Survey how durable-execution and agentic-workflow platforms model the three moves this
map is deciding, and extract patterns and anti-patterns relevant to a solo-operator,
BPMN-based, durable control plane. Cover a representative spread — e.g. Temporal, n8n,
Windmill, Kestra, Prefect, LangGraph, Camunda/Zeebe — on:

1. **Intake / routing** of incoming work (queues, triggers, classification, dispatch).
2. **Composition** of workflows (child workflows, call activities, sub-workflows, signals).
3. **Workflow library / catalog** with typed I/O contracts and discovery.

Note especially who owns the routing decision (deterministic vs model/agent) and how
each keeps composition durable — direct input to tickets 001, 003, 004, and 006.

## Resolution

Full report: [research/R02-prior-art-platforms.md](../research/R02-prior-art-platforms.md).
Surveyed Temporal, Camunda/Zeebe, Kestra, Prefect, Windmill, n8n, LangGraph.

- **Routing authority is never handed to a model directly.** Every platform keeps "which workflow
  runs" behind a deterministic artifact (gateway, Switch node, DMN table, trigger-config match),
  even where a classifier feeds it. Where a model is in the loop (n8n intent router, LangGraph
  supervisor) it proposes; a separate deterministic step disposes. Directly supports **ticket 001**
  resolving toward "meta vs intra" or straight deterministic routing — not open-ended "conscious
  flex." LangGraph's community even names the failure modes: "orchestrator-as-god" and
  "every-agent-can-call-every-agent."
- **Idempotent intake uses a stable correlation identity** (Temporal Workflow ID + reuse policy;
  Zeebe message correlation key). Flow Fabric's one-active-instance-per-workspace index already is
  this pattern — new intake sources should carry the same key discipline. Feeds **ticket 002**.
- **Composition median = call activity**: a separate instance, an explicit block/async choice, and
  explicit parent-on-child-failure semantics (Camunda's primitive, echoed by Kestra Subflow and
  Temporal child workflows). Feeds **ticket 003**. Durability trap is universal — checkpointing
  state alone replays side effects on resume (LangGraph admits this); validates Flow Fabric's
  re-arm-at-original-deadline approach and warns any composition primitive must get resume right.
- **Library template**: JSON-Schema-typed I/O per definition + immutable versioning + per-call
  version pinning (latest / pinned / pinned-with-caller — Camunda binding, Windmill path-vs-hash),
  plus a tagged/searchable catalog (Kestra Blueprints, Windmill Hub) rather than a heavyweight
  registry. Feeds **ticket 004** — largely "promote task-level `formSchema` to process level."

Feeds tickets 001, 002, 003, 004, and the synthesis (006).
