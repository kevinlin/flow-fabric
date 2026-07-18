import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { InstanceStore } from './store.js';
import type { DispatchDeps, EngineEnvironment, RunTaskFn } from './dispatch.js';
import { makeSingleAttemptRunTask } from './dispatch.js';
import type { Notifier } from '../notify/notifier.js';

type Contract = AgentTaskContract | CodeTaskContract;

export interface Hold {
  incidentId: number;
  contract: Contract;
  environment: EngineEnvironment;
  /** Releases the engine token with this output (skip / successful retry). */
  release: (output: Record<string, unknown>) => void;
  /** One fresh attempt against the runner. Throws on failure. */
  attempt: () => Promise<Record<string, unknown>>;
}

export interface LadderDeps extends DispatchDeps {
  store: InstanceStore;
  notifier?: Notifier;
  /** Registry shared with EngineHost, keyed `${instanceId}:${nodeId}`. */
  holds: Map<string, Hold>;
}

export function makeLadderRunTask(deps: LadderDeps): RunTaskFn {
  const single = makeSingleAttemptRunTask(deps);

  return (nodeId, contract, environment) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const key = `${deps.instanceId}:${nodeId}`;
      const attempt = () => single(nodeId, contract, environment);
      const hold = (incidentId: number) => {
        deps.holds.set(key, {
          incidentId,
          contract,
          environment,
          release: (output) => {
            deps.holds.delete(key);
            resolve(output);
          },
          attempt,
        });
      };

      void (async () => {
        // Restart with an open incident: re-hold, no runner call, no re-notify.
        const existing = deps.store.findOpenIncident(deps.instanceId, nodeId);
        if (existing) return hold(existing.id);

        let lastError: unknown;
        for (let n = 1; n <= contract.retries + 1; n++) {
          try {
            return resolve(await attempt());
          } catch (err) {
            lastError = err;
            deps.store.appendEvent(deps.instanceId, 'task.attempt-failed', nodeId, String(err));
          }
        }
        // Rung 2: modeled error boundary → let the engine route the token.
        if (deps.profile.errorBoundaryHosts.has(nodeId)) return reject(lastError as Error);
        // Rung 3: incident. Token pauses (promise stays pending).
        const incidentId = deps.store.createIncident(deps.instanceId, nodeId, String(lastError));
        deps.store.setStatus(deps.instanceId, 'incident');
        deps.store.appendEvent(deps.instanceId, 'incident.raised', nodeId, String(lastError));
        void deps.notifier?.notify(
          'Flow Fabric incident',
          `${deps.instanceId}: ${nodeId} failed after ${contract.retries + 1} attempts`,
        );
        hold(incidentId);
      })();
    });
}
