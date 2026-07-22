---
id: 004
title: "What is a 'workflow library', and how do workflows declare their I/O so the router can wire them?"
type: grilling
mode: HITL
status: closed
assignee: Kevin Lin
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

**Inherited from tickets 001 + 002 (deterministic routing, type==workflow):** the router
no longer needs the library as a match-against catalog — the source names the workflow
directly, so there is nothing for the router to "pick." The second bullet's routing
justification is mooted. The library therefore shrinks toward today's `DefinitionStore`
+ version pinning (latest-deployable / pinned). The **contract layer's remaining live
purpose is composition** (ticket 003): a typed handoff of process variables between a
caller workflow and a callee — not router matching. Re-scope this ticket around that when
it comes up.

## Resolution

Re-scoped as inherited: routing-matching is mooted (001/002 — the source names the
workflow), so the library is not a match-against catalog and the contract layer's only
live purpose is the composition handoff (003). Two decisions — the contract layer and
what a "library" is — resolved to the least that makes a factory of many workflows
navigable for a solo operator.

**The contract layer (envelope handoff):**

- **No process-level output contract.** A workflow does not declare a typed output. For a
  hard-named chain A→B, the handoff contract *is* B's input schema; a separate output schema
  on A would duplicate it and only earns its place when many callers/callees must match
  structurally — the deferred hierarchical/discovery world (fog). Typing lives on the receiving
  side only. Cost accepted: A→B intent is read off B, not visible from A's definition alone.
- **B declares a process-level `inputSchema` as JSON Schema**, replacing the flat
  `instanceInputs` `{name,type}` list with one input concept. Validated by the existing Ajv
  `validateOutput` machinery; carried in the moddle like `formSchema` / `outputSchema`. Chosen
  over keeping flat name/type because the envelope `input` is the one typed value crossing the
  composition boundary and deserves the same validation strength as the rest — `required`,
  `enum`, nested shapes — at near-zero build cost (Ajv + moddle patterns already exist). This is
  R02's "promote task-level `formSchema` to process level."
- **Envelope `input` validated twice.** Enqueue-time is the primary gate: a non-conforming
  envelope is rejected, failing producer A's terminal `scriptTask` into A's existing failure
  ladder (fail-fast, blame the producer, keep the bad row out of the durable queue). B-start
  re-validates as a durable-queue defense (B may have redeployed a changed schema since enqueue;
  a manually-inserted row must not crash-loop B silently). All three 002 enqueue sources (manual,
  timer, chain) share the enqueue gate — it is queue-level, not chain-specific.

**The library:**

- **Version binding.** The envelope is `{workflow, input, version?}`. Omit `version` →
  latest-deployable, resolved at dequeue; set it → that exact pinned version. Latest-default fits
  a solo operator's fast local edit/redeploy loop; the optional pin covers reproducible chains
  (a released pipeline, a regression repro). Queue-level rule; all enqueue sources inherit it.
  Semantics accepted: a long-queued job runs newest-at-dequeue, near-moot at solo per-workspace
  FIFO depth ~1 (R02's Camunda latest/pinned spread, trimmed to two modes).
- **"Library" = today's `DefinitionStore` + one `description` field.** A named list plus a
  one-line "what it does" is the smallest thing that turns a folder of files into a browsable
  library at solo scale. No tags, search, or catalog subsystem — those are library governance
  and stay fog until the library is large or shared.

**Bet — intact, verbatim.** The envelope is built by deterministic code (A's `scriptTask`),
validated by deterministic Ajv gates, and its version resolved by the deterministic queue. No
agent in the contract path; no gateway on agent output. 001's positioning holds word for word.

**Build items implied (for the future PRD, not built now):** promote `instanceInputs` →
JSON-Schema process-level `inputSchema`; enqueue-time + start-time validation on the 002 queue;
optional `version` on the envelope + dequeue resolution to latest-deployable; a `description`
column on `DefinitionStore`.

**Map deltas:** 006 now blocked only by 005. No new tickets. A typed process-level *output*
contract folds into the existing hierarchical/discovery fog; library-governance fog records that
description-only landed and tags/search/discovery stay deferred.
