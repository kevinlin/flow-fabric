---
id: R01
title: "Research — bpmn-engine composition capability"
type: research
mode: AFK
status: closed
assignee: wayfinder-session
blocked-by: []
---

## Question

Determine what `bpmn-engine` supports for composition and multi-instance, and whether
composition survives Flow Fabric's durability model:

- Call activities, embedded and expanded subprocesses, multi-instance markers.
- Starting or embedding a **sub-instance** (a second definition) from within a running
  instance.
- Whether each of the above preserves durable resume (`getState`/`recover`) and
  originally-scheduled timers across the composition boundary — the load-bearing property.

Consult the bpmn-engine docs (context7), the existing `engine-host` code, and the M1/M2
plan findings for known gotchas. Cheap probe evidence welcome but not required.

## Resolution

Full report: [research/R01-bpmn-engine-composition.md](../research/R01-bpmn-engine-composition.md).
Probe evidence: `packages/server/scripts/probe-composition.ts` (matches the `probe-*.ts` convention; not in build/test).

- `bpmn-engine` 25.0.1 / `bpmn-elements` 17.3.0 support **callActivity**, **embedded subProcess**,
  and **multi-instance** markers — and all three round-trip through `getState()`/`recover()` with
  timers firing at their **original deadline** across the boundary (probe: a 6s timer inside a
  subProcess, stopped at +3s and recovered, fired at ~6s total, not reset to 9s). Composition is
  durable "for free" when it stays inside one engine / one state blob.
- **Hard limit**: `callActivity` resolves `calledElement` only against `<process>` elements in the
  **same `<definitions>` source**. A cross-file id silently no-ops and the token waits forever.
  There is **no engine primitive to spawn a second definition**.
- **Recommended mechanism**: same-source `callActivity` + embedded `subProcess` (one engine, one
  state blob, control flow stays engine-owned). Composing genuinely separate/versioned definitions
  requires **host-level orchestration** — start a second instance and signal back — a real build
  with its own correlation/resume glue.
- Multi-instance works but the collection must bind via an extension attribute (`js:collection`)
  or `loopCardinality`; standard `<loopDataInputRef>` is not wired and throws.
- **Integration reality**: adopting composition is a **profile-expansion project, not a config
  change**. Today's layers are single-flat-process only — the linter rejects callActivity/subProcess
  (FF001), `readProfile` doesn't recurse into subprocess children (contracts missed → token stalls),
  dispatch keys on globally-unique node ids, and the `one_active_per_workspace` lock blocks
  host-orchestrated sibling instances on a shared workspace.

Feeds ticket 003 (composition mechanism) — now unblocked.
