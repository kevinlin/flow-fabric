# M1 Engine Spike — Findings

| | |
|---|---|
| Date | 2026-07-18 |
| bpmn-engine version | 25.0.1 |
| Verdict | GO |

## Questions and answers

| Question | Answer | Evidence |
|---|---|---|
| State serializes to JSON and recovers? | Yes. `getState()` returns a JSON-serializable snapshot; `new Engine().recover(state)` + `resume()` continues execution. | persistence.test.ts, resume.test.ts |
| Timer honors original schedule after in-process stop/resume? | Yes. Stopped ~3 s into a 6 s timer; after resume it fired at the original deadline (test wall-clock ~6 s total, resume leg ~3 s, within ±1.5 s slack). | resume.test.ts test 1 |
| Timer honors schedule after SIGKILL crash? | Yes. Child process killed mid-timer; parent recovered from the DB and the timer fired on the original schedule (resume leg ~3 s). | resume.test.ts test 2 |
| SQLite/WAL intact after SIGKILL? | Yes. The DB written by the killed child was readable by the parent; status was still `running` and `resumeAll()` picked it up. | resume.test.ts test 2 |
| Gateway loop + duration timer survives restart, no re-execution? | Yes. Restart during the second wait; exactly 3 `activity.end:work` events, no double execution after resume. | loop.test.ts event counts |
| timeCycle (R3/PT2S) supported on intermediate catch? | Partially: it fires once after one period (2 s) and the token moves on. No repetition; `R3` is ignored. Not usable for recurrence. | probe-timecycle.ts output, 2026-07-18 |
| State snapshot size for a small process | 4048 bytes | instances.engine_state for basic.bpmn |

## Additional observations

- Timer intermediate catch events never emit `activity.wait`. The arm signal is `activity.timer` (listener `api.id` = element id) and the fire signal is `activity.timeout`. `EngineHost` snapshots on `activity.timer`; anything downstream that watches for waiting timers must use that event, not `activity.wait`.
- `engine.getState()` is async; concurrent snapshots must be serialized (EngineHost queues them) or writes can interleave.
- Gateway conditions in `language="javascript"` with `next(null, bool)` work as expected, including after a resume.

## Workarounds required

None. The persistence, resume, and timer-schedule behavior needed for FR-9 works out of the box.

## Profile amendments

Restrict FR-6 timers to `timeDuration` only. `timeCycle` fires once and ignores the repeat count, so recurrence must be modeled as a gateway loop around a duration timer (the shape rfp-daily already uses). Applied to design_flow-fabric.md §4.1.

## Gate decision

GO — proceed to the M2 plan (runners + failure ladder). No re-plan needed; carry the `activity.timer` event naming and the timeDuration-only restriction into M2's engine-host work.
