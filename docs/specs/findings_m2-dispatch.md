# M2 Dispatch Spike — Findings

| | |
|---|---|
| Date | 2026-07-18 |
| bpmn-engine version | 25.0.1 (bpmn-elements 17.3.0) |
| Probe | `packages/server/scripts/probe-dispatch.ts` |

## Answers

| Question | Answer | Evidence (RESULT line) |
|---|---|---|
| Service override via `extensions` works, async, boundary-routes errors? | **Yes.** `activity.behaviour.Service = factory` whose `execute(msg, callback)` is invoked; async `callback(null, out)` completes and routes to `end`; `callback(err)` routes the token to the attached error boundary (no engine error). | `q1/succeed: ends=start,svc,end`; `q1/fail: ends=start,onErr,endErr outcome=end` |
| Custom `scripts` runs script tasks **and** JS conditions? Signatures? | **Yes.** `register({id,type,behaviour})` fires for every `bpmn:SequenceFlow` (condition in `behaviour.conditionExpression.body`) and every `bpmn:ScriptTask` (body in `behaviour.script`). `getScript(format, {id})` returns `{ execute(scope, callback) }`. Inline body compiled `new Function('next', body)`, run `fn.call(scope, callback)`. The loop ran correctly (count 1→2, condition true→false). | `q2: outcome=end registered=…SequenceFlow…ScriptTask…` |
| userTask emits `activity.wait`; `execution.signal` resumes; signal vars land where? | **Emits `activity.wait`** and appears in `getPostponed()`. Resumes via `execution.signal({id})`. **Signal payload vars are NOT persisted** and manual assign to `execution.environment.variables` writes to the wrong (top-level) env. Correct merge: write into the **running process** environment, then signal. | `q3/wait: waits=ask postponed=ask`; diagnostics below |
| Recover with `{extensions}` re-invokes in-flight service `execute`? | **Yes.** After `getState()` mid-service-task, `new Engine().recover(state, {extensions,…})` + `resume()` re-invokes the service `execute` for the in-flight node. This is what re-establishes a held incident after restart (Task 9). | `q4: calls=execute-first-run,execute:svc outcome=end` |

## The load-bearing correction: two variable environments

bpmn-engine 25 serializes **two** distinct variable stores, and the plan's assumed read path was wrong:

- `state.definitions[0].environment.variables` — top-level definition/engine env. Holds only the initial `execute({variables})` seed and assignments made via `execution.environment.variables`. **Runtime task outputs never appear here.**
- `state.definitions[0].execution.processes[0].environment.variables` — **process execution env. This is the real "now" of process variables.** Holds the seed *and* every task output, *and* is what `resolveInputs` reads (an activity's `activity.environment` IS this process env).

**Therefore, the canonical read path for process variables is:**

```
state.definitions[0].execution.processes[0].environment.variables
```

(It also carries `fields`/`content`/`properties` message noise keys — read specific variable keys, not the whole object.)

## Adjustments applied to Tasks 5 / 8 / 9

1. **Task 5 `varsOf()` test helper** reads `state.definitions[0].execution.processes[0].environment.variables`, not `…definitions[0].environment.variables`. Same for any state-variable assertion (timeline, user-task tests).
2. **Service/script output write is `Object.assign(activity.environment.variables, output)`** (plan code correct) — `activity.environment` is the process env, and outputs land in the canonical read path. Confirmed with a MARKER value.
3. **Scripts hook** — plan code correct: `register` filters SequenceFlows to those with a `conditionExpression.body`, compiles ScriptTask/condition bodies with `new Function('next', body)`, executes `fn.call(scope, callback)`. Inline-script variable mutations land in the process env (loop control flow verified).
4. **Task 5 `signal()` changes.** The plan's `Object.assign(execution.environment.variables, vars)` writes to the top-level env — wrong place. Correct mechanism (verified):
   ```ts
   const proc = entry.execution.definitions[0].getRunningProcesses()[0];
   Object.assign(proc.environment.variables, vars);
   entry.execution.signal({ id: nodeId });
   ```
   Signal payload vars (`signal({id, ...vars})`) do not persist. There is exactly one merge path: the running-process environment.
5. **Task 9 incident-after-restart** relies on q4 re-invocation — confirmed valid.

## Diagnostics (reproducible)

Written and run during the spike (then removed from the tree): a service task writing a MARKER value surfaced only at the process-execution env path; a userTask signal landed `approved` in the process env only when merged into `def.getRunningProcesses()[0].environment.variables` before `signal({id})`. `proc.environment === execution.environment` is `false` — the two envs are genuinely separate objects.
