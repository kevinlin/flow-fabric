# Flow Fabric — direction and vision

_Locked direction, decided via the [Wayfinder map](../wayfinder/map.md) (tickets 001–005, research R01/R02). Plan-only: this is the decision record a future PRD is built from, not a build spec. Status: locked 2026-07-22._

## Positioning

Flow Fabric is the control plane for a factory of AI Developer Workflows. One local daemon owns orchestration end to end: work arrives typed, deterministic routing dispatches it to the right workflow, workflows chain into pipelines, and a versioned library holds them. The engine owns orchestration at every level — agents decide neither the next node nor the next workflow.

"Control plane" stays the identity noun. "Factory" names the workload topology it governs: a capability layer of intake routing and a composable library, not the headline and not a second identity. The Kubernetes analogy holds and extends. Flow Fabric owns orchestration state across many workflows the way a control plane owns a cluster; each workspace is still pure workload.

A Developer Workflow develops an artifact: code, a bid, or a governed report. It need not be code. The flagship `rfp-daily` develops a governed bid. Software development is one workflow among business-ops routines, not the domain.

## The vision

A solo operator runs a local factory of specialized workflows. Typed jobs arrive (enqueued by hand, fired on a cadence, or handed off by a workflow that just finished), and a deterministic queue dispatches each to the workflow it names. Workflows chain: one produces an artifact on a workspace, then enqueues the next, so a bid audit can flow into a submission-prep run without a human relaying between them. The engine keeps every run durable across restarts and multi-day timers. Through all of it, no model ever decides what runs next. That constraint is the product, not a limitation of it: reliable, repeatable completion is what makes the factory trustworthy enough to leave running.

## Locked decisions

- **Authority: deterministic routing (001).** Work arrives pre-typed; a coded exclusive gateway dispatches on the type field. No routing gateway condition ever reads an agent-produced value. Agents may run as intake tasks (summarize, extract, validate, enrich), but the type a gateway switches on is operator- or source-supplied, never agent-inferred. This is what makes "deterministic routing" true rather than nominal. Positioning: _the engine owns orchestration at every level; agents never decide what runs next, neither the next node nor the next workflow._

- **Intake: a typed job envelope on a minimal durable queue (002).** One arriving job is `{ workflow (definition + version policy), workspace (target folder = correlation identity), input (typed params), enrichment? (agent-populated, never routed on) }`. The source names the workflow directly; there is no category→workflow map. Sources for v-next: manual enqueue plus timer-enqueue (a deterministic scheduler firing fresh instances on a cadence). The queue is FIFO, per-workspace serialized (target busy → the job waits, never drops, never silently stalls), deduped on correlation identity. Two recurrence models coexist: intra-workflow loop when "run again?" is itself flow control (the flagship stays as-is); timer-enqueue when the cadence is pure scheduling (the CronJob split: schedule is a controller concern, not workload logic).

- **Composition: pipeline chaining, zero new BPMN elements (003).** A workflow runs to completion, then the next starts; no parent waits. The chain is expressed in-BPMN and hard-named: a terminal `scriptTask` enqueues the successor's envelope onto the 002 queue (a third enqueue source); exclusive gateways handle conditional chains. The workspace carries the work product between runs; the envelope `input` carries the small typed params. It reuses `scriptTask` + exclusive gateway + end event: no linter change, no `readProfile` recursion, no dispatch re-keying, no workspace-lock rework. One runtime item: an enqueue-job API reachable from a code contract. Durable for free (independent single-process instances; double-enqueue covered by the queue's dedup). No first-class "pipeline" object; a pipeline is emergent from hard-named chains.

- **Library and contracts: the least that makes a factory navigable (004).** No process-level output contract; typing lives on the receiving side, so a hard-named chain's contract _is_ B's input schema. A workflow declares a process-level `inputSchema` (JSON Schema), replacing the flat `instanceInputs` list, Ajv-validated like `formSchema`. The envelope `input` is validated twice: at enqueue (fails the producer's failure ladder, keeps bad rows out of the queue) and at dequeue/start (durable-queue defense). The envelope is `{workflow, input, version?}`: latest-deployable by default resolved at dequeue, optional pin for reproducible chains. "Library" = today's `DefinitionStore` plus one `description` field, with no tags, search, or catalog subsystem.

- **Identity: general ADW factory, control plane still the noun (005).** Domain-neutral: software development is one workflow among many, not the domain. This was foreclosed rather than chosen: 001–004 already built a general router (no category map) and a general library, so committing to a code-centric factory would mean revising locked decisions. Generality is asserted, not proven by a second exemplar in v-next. IndyDevDan's Software Factory is generalized lead inspiration: his code-specific factory is one instance of Flow Fabric's domain-neutral one.

**The core bet, unchanged and strengthened by the generality:** the engine owns orchestration; the agent never decides what runs next; the workspace is the workload; BPMN is the source of truth. Every decision above is built from deterministic code: coded gateways, a deterministic queue and scheduler, Ajv validation, deterministic version resolution. No agent sits on any routing or composition decision. A general factory running over deterministic routing demonstrates the control-plane claim holds regardless of whether the workload is code or a bid.

## Scope boundary — what stays fog

These are on the horizon and the vision may gesture at them, but they are not v-next commitments:

- **Hierarchical call-and-return composition:** a workflow invoking a sub-workflow mid-flight and consuming its result. Deferred by 003 in favour of chaining; it is the R01 profile-expansion project (callActivity/subProcess + linter + `readProfile` recursion + dispatch keying + workspace-lock rework), and it carries the deferred typed process-level _output_ contract.
- **Parallelism and sandboxes:** isolated worktrees, concurrent attempts, first-to-pass racing.
- **Beyond one operator / one machine:** team/multi-user, multiple repos, remote/cloud execution.
- **Cross-factory observability:** how dashboards, incidents, and the inbox scale across many workflows, including watching a running pipeline.
- **Library governance:** tags, search, catalog, and cross-machine sharing (description-only landed; the rest waits until the library is large or shared).
- **A second, code-domain exemplar:** the workflow that would _prove_ generality rather than assert it. Roadmap, and the software-factory demo a Zühlke audience expects.

## What a future PRD must carry

Build items implied by the locked decisions (below vision altitude):

- A minimal durable queue: FIFO, per-workspace serialized, correlation-identity dedup, concurrent across workspaces.
- Timer-enqueue scheduler (deterministic), with a missed-tick policy on daemon downtime (catch-up / skip / fire-once), a decision on where schedule config lives, and a cross-workspace concurrency cap.
- An enqueue-job API on the engine-host reachable from a code contract (the chaining runtime item), shared by all three enqueue sources (manual, timer, chain).
- Promote `instanceInputs` to a process-level `inputSchema` (JSON Schema); enqueue-time and start-time validation of the envelope `input`.
- Optional `version` on the envelope, plus dequeue resolution to latest-deployable.
- A `description` column on `DefinitionStore`.

## Prior art

R02 surveyed Temporal, Camunda/Zeebe, Kestra, Prefect, Windmill, n8n, and LangGraph. The direction sits inside the established pattern rather than against it: routing authority is never handed to a model directly (every platform keeps "which workflow runs" behind a deterministic artifact); idempotent intake uses a stable correlation identity (our per-workspace lock); call activity is the composition median (we chose chaining for v-next and deferred call-and-return consciously); and the library template is typed I/O + versioning + a description, with tags/search/catalog deferred. The one hold R02 warns against, orchestrator-as-god (a model owning dispatch), is the one this direction rejects outright.
