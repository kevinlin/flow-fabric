# R02 — Prior art: routing, composition, and workflow libraries in comparable platforms

Research ticket: [docs/wayfinder/tickets/R02-research-prior-art-platforms.md](../tickets/R02-research-prior-art-platforms.md).
Feeds tickets 001 (routing authority), 002 (intake model), 003 (composition mechanism), 004 (library + I/O contracts).

Platforms surveyed: Temporal, Camunda/Zeebe (BPMN), Kestra, Prefect, Windmill, n8n, LangGraph.
For each: how work arrives and gets routed, how workflows compose, and how a workflow library
declares itself and its I/O.

---

## Temporal

**Intake / routing.** Task Queues route *tasks* (workflow tasks, activity tasks) to whichever
Worker process is polling that queue — this is infrastructure routing (which compute runs the
next step), not business routing (which workflow answers this request). The decision of "start
workflow type X" is made by the calling application code before Temporal is ever invoked: the
caller picks a Workflow Type and a Workflow ID and calls start. There's no engine-level
classifier. Idempotent intake is handled via **Workflow ID + Workflow ID Reuse Policy** — the
platform guarantees ID uniqueness within a namespace per the chosen policy (e.g. reject a
duplicate start unless the prior run failed/timed out/was terminated), and Signal-With-Start
lets a caller "signal, starting if needed" atomically. Dedup for a signal payload itself is the
workflow author's job (custom idempotency key), but the server handles Update dedup by ID.
[Task Queues](https://docs.temporal.io/task-queue) ·
[Workflow Id and Run Id](https://docs.temporal.io/workflow-execution/workflowid-runid) ·
[community: signal dedup](https://community.temporal.io/t/deduping-workflow-signals/5547)

**Composition.** Child Workflows are started from a parent, with **no shared local state** —
only signals, start input, and completion output cross the boundary. Each child gets its own
Event History; a **Parent Close Policy** governs whether children are terminated, cancelled, or
left running when the parent closes. Gotcha directly analogous to Flow Fabric's own bpmn-engine
traps: **Continue-As-New does not carry children over** — a parent that continues-as-new orphans
its in-flight children according to their close policy, which is easy to miss.
**Nexus** (GA) is the newer, cross-namespace/cross-team composition primitive: a **Nexus
Service** is a named collection of typed **Operations** with an explicit input/output contract
package, callable durably from another namespace without the caller knowing whether the callee
starts a workflow, signals one, or runs a query. It's the closest thing in Temporal to a
contract-first, discoverable "library" boundary between workflows owned by different teams.
[Child Workflows](https://docs.temporal.io/child-workflows) ·
[Temporal Nexus](https://docs.temporal.io/nexus) ·
[Nexus GA announcement](https://temporal.io/blog/temporal-nexus-now-available)

**Library / catalog.** No built-in UI catalog. Workflow types are code registered by a Worker;
discovery is via source control and the SDK, not a browsable registry. Nexus Services are the
closest analog to a discoverable, versioned, typed catalog entry, but that's a cross-namespace
feature, not a general workflow library.

---

## Camunda / Zeebe (BPMN)

**Intake / routing.** **Message start events with a correlation key** are the BPMN-native intake
primitive: if the message carries a correlation key, Zeebe uses it to guarantee only one active
process instance per key (idempotent intake); an empty key always starts a new instance and
skips the check. Messages are buffered until they can be correlated against a running instance's
subscription. Routing *which path a running instance takes* is done with **exclusive gateways**,
and Camunda explicitly recommends offloading complex boolean routing logic to a **DMN decision
table** feeding a business rule task, rather than nesting deep gateway conditions — the docs call
out that expressing many conditions directly in BPMN gateways gets "verbose" and "hard to
maintain." In the canonical Camunda story there is no model/agent in this loop at all: routing is
rules and config, evaluated deterministically, with full history of which rule fired and why.
[Message correlation](https://camunda.com/blog/2019/08/zeebe-message-correlation/) ·
[Message events](https://docs.camunda.io/docs/components/modeler/bpmn/message-events/) ·
[DMN decision tables](https://camunda.com/blog/2025/02/decision-tables-for-automating-business-rules/)

**Composition.** Two distinct primitives, cleanly separated:
- **Embedded subprocess** — defined inside the parent process definition, shares its scope; a
  boundary event on the subprocess catches events raised during its execution. Not a separate
  instance.
- **Call activity** — references an *external* process definition. Arriving at a call activity
  creates a **new process instance**; the parent instance blocks and waits until the child
  instance fully ends, then continues. This is a genuinely separate, engine-tracked instance with
  its own lifecycle, not a shared-scope construct.

The version-resolution detail is the load-bearing one for a library question: a call activity's
**binding** is configurable — by default it invokes the **latest** deployed version of the
called process at each instantiation, but it can instead be pinned to a **specific version**, or
to **"the version deployed together with the parent"** (i.e., versioned in lockstep with the
caller). Running instances of any given process stay pinned to the version they started with
even after a redeploy; only new instances pick up the new version.
[Call Activity](https://docs.camunda.org/manual/7.5/reference/bpmn20/subprocesses/call-activity/) ·
[Versioning process definitions](https://docs.camunda.io/docs/components/best-practices/operations/versioning-process-definitions/)

**Library / catalog.** Comparatively thin. `RepositoryService` plus deployment-descriptor
folders/tags, or Web Modeler "projects," organize definitions, but there's no first-class typed
I/O contract on a process definition out of the box — that needs a plugin (e.g. a community
Modeler plugin adding an I/O-specification tab) or convention. Versioning and the call-activity
binding model are strong; discovery/catalog tooling is weak next to the no-code platforms below.

---

## Kestra

**Intake / routing.** Multiple **deterministic** trigger types feed one dispatcher: Schedule
(cron), Webhook, file-arrival, message-queue (Kafka/SQS/RabbitMQ), and a **Flow Trigger** that
fires when another flow completes, filtered by explicit **preconditions** (`FLOW_ID`,
`NAMESPACE`, `STATE`, `EXPRESSION`). No model or classifier decides which flow runs; it's
config-matching throughout. Of the platforms surveyed, this is the cleanest example of
"many deterministic trigger sources feeding config-driven dispatch."
[Triggers](https://kestra.io/docs/workflow-components/triggers) ·
[Flow Trigger](https://kestra.io/docs/workflow-components/triggers/flow-trigger)

**Composition.** A purpose-built `io.kestra.plugin.core.flow.Subflow` task: specify the target's
`flowId`/`namespace`; `wait` (default **true**) controls blocking vs fire-and-forget; when
`wait` is true, `transmitFailed` decides whether a subflow failure propagates as a parent
failure. Outputs come back through `outputs.<subflow_id>.outputs.<field>`. This is the closest
no-code analog to a BPMN call activity, with sync/async made an explicit per-call choice.
[Subflows](https://kestra.io/docs/workflow-components/subflows)

**Library / catalog.** Namespaces scope and organize flows. Flows declare **typed Inputs**
(validated at runtime) and **Outputs**. Every edit auto-creates a new **revision** (viewable,
diffable). **Blueprints** are a curated, tagged, searchable catalog of ready-to-use flows —
official and community — usable directly from the flow editor via a one-click "Use" action.
Among the surveyed platforms this is the strongest combination of typed I/O + discoverable,
tagged catalog + built-in revision history.
[Blueprints](https://kestra.io/docs/concepts/blueprints) · [Flows](https://kestra.io/docs/workflow-components/flow)

---

## Prefect

**Intake / routing.** A **Deployment** decouples a flow (code) from *how/when* it runs — one
flow can have N deployments, each with its own schedule, parameters, and infrastructure target.
Work Pools and Work Queues are infra-provisioning/prioritization (which worker picks up which
scheduled run) — again, compute routing, not business routing. Event-driven intake is
**Automations**: an event (state change or external) is matched against a trigger config
(`match`, `expect` — deterministic filters, not classification), and a Jinja template maps event
payload fields into the target deployment's typed flow parameters. There's no model deciding
"which flow" — the mapping from trigger to flow is authored ahead of time as config.
[Automations - triggers](https://docs.prefect.io/v3/automate/events/automations-triggers) ·
[Deployments](https://docs.prefect.io/v3/concepts/deployments)

**Composition.** Subflows are literally calling a `@flow`-decorated function from inside
another flow, or firing a separately deployed flow via `run_deployment`. Nested runs get their
own task runner and are tracked as distinct, observable runs in the UI. Durability gap worth
flagging: **Prefect 2.x has no built-in mechanism to resume a crashed flow from its exact point
of failure** — retries are configured at task granularity, not as automatic whole-flow
checkpoint/replay; a subflow that crashes (e.g. pod eviction) is reported to the parent as a
**terminal failure**, and the parent does not automatically cancel remaining children on its own
crash — that needs a separate Automation. Composition here is primarily an
organization/observability feature, not a durability primitive.
[Flows](https://docs.prefect.io/v3/concepts/flows) ·
[GitHub: crashed subflow marks parent failed](https://github.com/PrefectHQ/prefect/issues/10620) ·
[GitHub: no crash-state retry](https://github.com/PrefectHQ/prefect/issues/10211)

**Library / catalog.** The Deployment *is* the catalog entry: name + flow + schedule + typed
parameters (Python type hints, including full Pydantic models, auto-coerced and validated, and
rendered into a parameter form), declared in `prefect.yaml`. No public community template
marketplace; the catalog is internal/team-scoped, not something a solo operator would browse
the way they'd browse Kestra Blueprints or the Windmill Hub.

---

## n8n

**Intake / routing.** Trigger nodes are the intake surface: Webhook, Schedule, manual, error
trigger, chat trigger, "When Executed by Another Workflow." A workflow is fixed 1:1 to its
trigger — there's no platform-level router that automatically picks among many workflows.
Where teams want that, they build it themselves, and the common pattern is: an **AI node
classifies intent**, then a plain **Switch node** routes to the matching sub-workflow. That
means model-driven classification is common in practice, but it's user-assembled, sits *inside*
one workflow, and the actual dispatch is still a deterministic node reading the classifier's
output — structurally close to ticket 001's "meta vs intra" framing (model proposes, a
deterministic gateway disposes).
[AI Intent Router pattern](https://community.n8n.io/t/ai-intent-router-classify-and-route-messages-to-different-handlers/259959)

**Composition.** The `Execute Workflow` / `Execute Sub-workflow Trigger` node pair. An explicit
**"Wait for Sub-Workflow Completion"** toggle makes sync vs async a per-call choice. Input rows
map into the child's trigger node; the child's last node's output flows back to the parent.
Constraint worth noting: the callee **must** use the "When Executed by Another Workflow"
trigger — a workflow whose trigger is a Webhook can't be invoked this way, so making a workflow
composable sometimes means maintaining a second copy with a different trigger, purely to be
callable.
[Execute Sub-workflow node](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.executeworkflow/)

**Durability.** n8n's crash recovery is **log-based reconstruction**, not replay from serialized
engine state: an `ExecutionRecoveryService` walks event-bus logs after a restart to infer which
nodes started/finished, and marks unfinished ones `NodeCrashedError`. This is forensic
best-effort, not a guarantee of resuming exactly where execution left off — documented issues
show it can mis-mark previously-successful runs as "crashed" after a rapid worker restart. Useful
as a concrete negative example against Flow Fabric's replay-from-`getState()` model.
[Execution recovery](https://deepwiki.com/n8n-io/n8n/2.4-execution-recovery-and-error-handling) ·
[GitHub: crashed after rapid restart](https://github.com/n8n-io/n8n/issues/22541)

**Library / catalog.** [n8n.io/workflows](https://n8n.io/workflows/) is a large (10,000+),
searchable community template marketplace — but templates are copy-in starting points, not
live, versioned dependencies; there's no built-in semantic versioning of "workflow as a
callable unit," and teams bolt on Git-sync/backup workflows themselves to get any version
history at all. No JSON-Schema-typed I/O contract layer beyond each node's own parameter schema;
the sub-workflow trigger's input fields are a de facto but informal contract.

---

## Windmill

**Intake / routing.** Broad, deterministic trigger surface: schedules (cron via `croner`),
webhooks, HTTP routes, Kafka, WebSockets, email, and **trigger scripts** (poll-based — pull new
items since the last run without an external webhook). Approval steps suspend for a webhook
call (human-in-the-loop), not agent routing. No platform concept of a model choosing which flow
runs; that's user-built inside a flow if wanted.
[Scheduling](https://www.windmill.dev/docs/core_concepts/scheduling)

**Composition.** A flow step's module type can itself be "flow," calling another flow as a
subflow inside the DAG; steps reference prior outputs via `results.<step_id>...`. Scripts and
flows are **content-addressed and immutable** — every deployment gets a hash, and referring to a
script/flow "by path" always resolves to the *latest* hash deployed at that path, while referring
"by hash" pins to that exact version. This is a clean, explicit answer to "how does a caller pin
vs float on the callee's version."
[JSON schema and parsing](https://www.windmill.dev/docs/core_concepts/json_schema_and_parsing)

**Library / catalog.** JSON Schema (2020-12) is the native contract format throughout: Windmill
**auto-infers a JSON Schema from a script's function signature**, autogenerates a form UI from
it, and the same mechanism defines flow inputs. The **Windmill Hub** is a public, moderated
catalog of shareable scripts and flows. Combined with immutable hash-per-deployment, this is the
strongest "typed I/O contract + versioning + catalog" package among the platforms surveyed.

---

## LangGraph (LangChain)

**Intake / routing.** LangGraph has **no intake layer of its own** — it's an embeddable graph
library. "Which graph runs for this request" is decided entirely by the calling application (an
API route, a queue consumer) *before* LangGraph is invoked. LangGraph Platform adds
**assistants** — named, versioned configurations of a graph (prompt/model swaps without
touching graph logic) — closer to "a named variant of one workflow" than "which workflow." At
the outer boundary LangGraph has nothing to say about routing; every routing concept it does
have (conditional edges, `Command`, supervisor patterns) operates strictly *inside* one graph.
[LangGraph Platform GA](https://www.langchain.com/blog/langgraph-platform-ga)

**Inside a graph.** Two distinct shapes for "what runs next": plain **conditional edges** (a
function inspecting state — the closest analog to a BPMN exclusive gateway) and
**`Command(goto=..., update=...)`**, which lets a node pick its own next node *and* mutate state
in one return value — the mechanism behind supervisor/handoff multi-agent patterns, including
`Command(graph=Command.PARENT)` for a subgraph to hand control back up to its parent. Community
guidance names two explicit anti-patterns to avoid: **"orchestrator-as-god"** (one planner LLM
holds all state and calls every sub-agent) and **"every-agent-can-call-every-agent"** (an
arbitrary mesh where any agent can invoke any other). The recommended shape instead: each node
decides its own next hop from a narrow, explicit state check, not a central planner reasoning
over the whole state — i.e. even inside an agent-native framework, practice converges on
*bounding* where non-determinism is allowed rather than removing structure altogether.
[Command announcement](https://www.langchain.com/blog/command-a-new-tool-for-multi-agent-architectures-in-langgraph) ·
[Anti-pattern discussion](https://dev.to/gabrielanhaia/multi-agent-handoff-with-ownership-boundaries-nobody-crosses-nll)

**Composition / durability.** A checkpointer snapshots full graph state at every "superstep"
(keyed by thread + checkpoint id), enabling resume, time-travel, and human-in-the-loop
interrupts. The load-bearing caveat: **resume re-runs the interrupted node from its start, not
from a mid-function line** — any side-effecting step (tool call, external write, LLM call) will
be re-triggered on replay unless the node author gives it its own idempotency key. This is the
same failure class Flow Fabric's `bpmn-engine` gotchas already guard against (re-arm timers at
their *originally scheduled* time rather than restarting them) — direct external confirmation
that checkpointing state is not sufficient by itself; the causal event log matters too.
[Durable execution limitations](https://www.zenml.io/blog/langgraph-durable-runtime) ·
[HITL double-execution problem](https://blog.raed.dev/posts/langgraph-hitl/)

**Library / catalog.** Subgraphs are embedded graphs compiled once and invoked as a node — no
external catalog. LangGraph Platform's "assistants" are the nearest thing to a registered,
versioned, discoverable unit, but they carry a Python/TS state-schema type, not a portable
JSON-Schema-style contract a router could introspect generically the way Windmill or Kestra's
inputs can.

---

## Cross-cutting synthesis

### Patterns worth stealing

1. **Deterministic dispatch, model only classifies.** Across every platform, the actual
   "which code path runs" decision sits in a deterministic artifact — a gateway condition, a
   Switch node, a trigger-config match, a DMN table. Where a model is involved (n8n's intent
   classifier, LangGraph's supervisor), it produces a value or bounded proposal that a
   *separate* deterministic step consumes; the model is never wired directly to "start this
   workflow." Directly supports ticket 001's "meta vs intra" hold.
2. **Idempotent intake via a stable correlation identity** (Temporal Workflow ID + reuse policy;
   Zeebe message correlation key) — both treat "the same logical unit of work arriving twice"
   as a first-class problem solved by identity, not by trusting the trigger to fire once. Flow
   Fabric's one-active-instance-per-workspace unique index is already this pattern; feeds
   ticket 002.
3. **Sync/async made an explicit per-call choice**, not an implicit property of the mechanism —
   n8n's "wait for completion" toggle, Kestra's `wait`/`transmitFailed`, Temporal's
   blocking-vs-fire child start. Directly informs ticket 003.
4. **Version pinning as a configurable choice at the call site** — Camunda's call-activity
   binding (latest / specific version / version-deployed-with-parent), Windmill's
   path-resolves-latest-hash vs pin-by-hash. Near-complete answer for ticket 004's currently-fog
   "library governance" question.
5. **Typed I/O is what makes a workflow wireable**, not just its name — Windmill's
   JSON-Schema-from-signature, Kestra's declared typed inputs/outputs, Prefect's Pydantic
   parameters. Every platform where composition or triggered dispatch works cleanly, the callee
   publishes a schema. Direct precedent for ticket 004's contract layer.
6. **A tagged, searchable catalog with a low-friction "use this" action** (Kestra Blueprints,
   Windmill Hub) makes a library navigable at solo-operator scale without heavyweight
   governance — search + tags + one write action, not a formal registry with approval gates.

### Anti-patterns to avoid

1. **Orchestrator-as-god / every-agent-can-call-every-agent** (LangGraph community's own naming)
   — a single planner LLM holding all state, or a mesh where any agent invokes any other, erodes
   exactly the property Flow Fabric's core bet protects. Direct evidence for resolving ticket 001
   toward "deterministic routing" or "meta vs intra," not open-ended "conscious flex."
2. **Checkpointing state without the causal event log reintroduces non-idempotency on resume**
   (LangGraph: an interrupted node reruns from its top, replaying tool/LLM calls unless manually
   made idempotent). This is exactly the failure class bpmn-engine avoids by re-arming timers at
   their *originally scheduled* time rather than restarting them — external validation of Flow
   Fabric's existing approach, and a warning that any new composition primitive must get resume
   semantics equally right, not just "add a checkpoint."
3. **Coupling trigger type to invocation path** (n8n: a webhook-triggered workflow can't be
   invoked as a sub-workflow; it needs a duplicate copy with the "When Executed by Another
   Workflow" trigger) — this forces workflow variants that exist purely to be composable,
   doubling maintenance for no functional gain.
4. **Treating a callee's crash as an automatic terminal failure with no defined parent
   contract** (Prefect: a subflow crash from infra eviction is reported to the parent as
   terminal; cascading cancellation isn't automatic either). Durability of the callee's own
   execution and the parent-child failure contract are two separate design problems — glossing
   over the second leaves an operational gap. Flow Fabric's failure ladder (retry → boundary
   event → incident) already treats this per node; a composition primitive needs the same
   explicitness at the call-activity boundary.
5. **A catalog that's just a folder of files with no typed contract** (Camunda's baseline
   repository/deployment-folder model) leaves "which workflow does what, and what does it need"
   as tribal knowledge — a router (or an operator) can't match against a contract that doesn't
   exist. Reinforces that ticket 004's contract layer isn't optional plumbing; it's what makes
   routing and library actually connect, per the ticket's own framing.
6. **Confusing infra-routing with business-routing** — Temporal Task Queues and Prefect Work
   Pools/Queues route bytes to available compute, not "which workflow answers this request."
   Worth flagging so Flow Fabric doesn't conflate "which node/task executes on which runner"
   with "which workflow definition starts for a given intake item" — different decisions,
   different owners, despite both using the word "queue."

### Implications for a BPMN durable control plane

- **Ticket 001** — resolve toward "meta vs intra" or straight deterministic routing: every
  platform surveyed keeps the dispatch decision in a deterministic artifact even where a model
  classifies upstream. An agent can enrich/classify inside a router *workflow*, but the router's
  own exclusive gateway — engine-owned — makes the call. This is the median industry pattern,
  not a novel compromise.
- **Ticket 002** — adopt identity-based dedupe at intake (workspace path, or a ticket/request
  ID, as the correlation key), mirroring Temporal's Workflow ID reuse policy and Zeebe's message
  correlation key. Flow Fabric's one-active-instance-per-workspace index already does this;
  extending intake (folder watch, webhook, cron) should carry the same key discipline rather
  than inventing separate queue semantics.
- **Ticket 003** — call activity is the closest fit to the industry median (Camunda's own
  primitive, mirrored by Kestra's Subflow task and Temporal child workflows): a separate
  instance, an explicit block/async choice, and explicit parent-on-child-failure semantics. If
  the profile grows a call-activity element, the failure ladder needs a defined meaning across
  that boundary — what a callee incident does to the caller — not just within one process.
- **Ticket 003 (durability)** — whatever composition primitive is chosen must re-arm on resume
  the same way `bpmn-engine` already does for timers; checkpointing engine state is not
  sufficient by itself (LangGraph's own docs warn of exactly this). If a call activity's callee
  is mid-flight when the daemon restarts, `resumeAll()` needs to reconstruct both instances'
  relationship, not just each instance's own state independently.
- **Ticket 004** — the typed I/O contract should be a JSON Schema on a process's declared
  inputs/outputs, mirroring Windmill/Kestra/Prefect — and it's close to what Flow Fabric already
  has at task level (`formSchema`, output JSON Schema per task contract). This ticket is really
  "promote that same idea from task-level to process-level." Version pinning at the call site
  should be an explicit choice (latest / pinned-to-version / pinned-with-caller), following
  Camunda's call-activity binding options and Windmill's path-vs-hash split — not a silent
  default.
- **Ticket 004 ("what library means")** — the cheap, solo-operator-scale answer other platforms
  converge on: a tagged, searchable list of definitions, each with a schema and its own version
  history (Kestra Blueprints + revisions, Windmill Hub + hash-per-deploy) — not a heavyweight
  registry with approval gates. `DefinitionStore` already gives immutable versions; the
  remaining fog is discovery/tagging/schema surfacing, not a new storage model.
