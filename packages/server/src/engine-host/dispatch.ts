import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { ProcessProfile } from '../profile/read.js';
import type { InstanceStore } from './store.js';
import type { Events } from '../events/events.js';
import type { TaskRunner } from '../runners/types.js';
import { validateOutput } from '../runners/validate.js';

export interface RunnerSet {
  agent: TaskRunner;
  code: TaskRunner;
}

export interface EngineEnvironment {
  variables: Record<string, unknown>;
}

export type RunTaskFn = (
  nodeId: string,
  contract: AgentTaskContract | CodeTaskContract,
  environment: EngineEnvironment,
) => Promise<Record<string, unknown>>;

export interface DispatchDeps {
  instanceId: string;
  workspace: string;
  dataDir: string;
  profile: ProcessProfile;
  runners: RunnerSet;
  /** Set by EngineHost; when present, each attempt is recorded in task_executions (FR-14). */
  store?: InstanceStore;
  /** Set by EngineHost; drives the task-execution telemetry span after each attempt. */
  events?: Events;
  /** Overridden by the failure ladder. Default: one attempt, validate, throw on failure. */
  runTask?: RunTaskFn;
}

export function resolveInputs(
  contract: AgentTaskContract | CodeTaskContract,
  environment: EngineEnvironment,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const decl of contract.inputs) inputs[decl.name] = environment.variables[decl.name];
  return inputs;
}

export function makeSingleAttemptRunTask(deps: DispatchDeps): RunTaskFn {
  // Per-node attempt counter so ladder retries get real attempt numbers.
  const attempts = new Map<string, number>();
  return async (nodeId, contract, environment) => {
    const attempt = (attempts.get(nodeId) ?? 0) + 1;
    attempts.set(nodeId, attempt);
    const inputs = resolveInputs(contract, environment);
    const recId = deps.store?.startTaskExecution(deps.instanceId, nodeId, contract.kind, attempt, inputs);
    const controller = new AbortController();
    const timeoutMs = contract.timeoutSeconds * 1000;
    const timer = setTimeout(
      () => controller.abort(new Error(`task ${nodeId} timed out after ${contract.timeoutSeconds}s`)),
      timeoutMs,
    );
    const timedOut = new Promise<never>((_, reject) =>
      controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true }),
    );
    try {
      const runner = contract.kind === 'agent' ? deps.runners.agent : deps.runners.code;
      const result = await Promise.race([
        runner.run(contract, inputs, {
          instanceId: deps.instanceId,
          nodeId,
          workspace: deps.workspace,
          attempt,
          signal: controller.signal,
          dataDir: deps.dataDir,
        }),
        timedOut,
      ]);
      validateOutput(contract.outputSchema, result.output);
      if (recId !== undefined) {
        deps.store!.finishTaskExecution(recId, {
          status: 'completed',
          output: result.output,
          tokenUsage: result.tokenUsage,
          costUsd: result.costUsd,
          transcriptPath: result.transcriptPath,
        });
        deps.events?.taskExecution(recId);
      }
      return result.output;
    } catch (err) {
      if (recId !== undefined) {
        deps.store!.finishTaskExecution(recId, { status: 'failed', error: String(err) });
        deps.events?.taskExecution(recId);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function createDispatch(deps: DispatchDeps): { extensions: object; scripts: object } {
  const runTask = deps.runTask ?? makeSingleAttemptRunTask(deps);

  // ServiceTask interception (probe q1): swap in a Service factory for agent
  // contracts; execute(msg, callback) runs the task and merges output into the
  // process execution environment (findings_m2-dispatch.md).
  const extensions = {
    flowfabric(activity: any) {
      const contract = deps.profile.contracts.get(activity.id);
      if (activity.type !== 'bpmn:ServiceTask' || contract?.kind !== 'agent') return;
      activity.behaviour.Service = function FlowFabricService() {
        return {
          execute(_msg: unknown, callback: (err?: Error | null, out?: unknown) => void) {
            runTask(activity.id, contract, activity.environment)
              .then((output) => {
                Object.assign(activity.environment.variables, output);
                callback(null, output);
              })
              .catch((err: Error) => callback(err));
          },
        };
      };
    },
  };

  // Scripts registry (probe q2): contract scriptTasks → code runner; inline
  // <script> bodies and JS conditionExpressions → compiled Function with the
  // same semantics as bpmn-engine's default (this = scope, next(err, result)).
  const registry = new Map<string, { execute(scope: any, next: (...a: unknown[]) => void): void }>();
  const scripts = {
    register({ id, type, behaviour }: any) {
      if (type === 'bpmn:SequenceFlow') {
        const body = behaviour.conditionExpression?.body;
        if (!body) return;
        const fn = new Function('next', body);
        registry.set(id, { execute: (scope, next) => fn.call(scope, next) });
        return;
      }
      if (type !== 'bpmn:ScriptTask') return;
      const contract = deps.profile.contracts.get(id);
      if (contract?.kind === 'code') {
        registry.set(id, {
          execute(scope: any, next) {
            runTask(id, contract, scope.environment)
              .then((output) => {
                Object.assign(scope.environment.variables, output);
                next(null, output);
              })
              .catch((err: Error) => next(err));
          },
        });
      } else if (behaviour.script) {
        const fn = new Function('next', behaviour.script);
        registry.set(id, { execute: (scope, next) => fn.call(scope, next) });
      }
    },
    getScript(_format: string, { id }: any) {
      return registry.get(id);
    },
  };

  return { extensions, scripts };
}
