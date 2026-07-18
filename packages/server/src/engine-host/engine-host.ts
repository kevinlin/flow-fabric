import { EventEmitter } from 'node:events';
import os from 'node:os';
import { Engine } from 'bpmn-engine';
import { flowfabricModdle } from '@flowfabric/shared';
import type { InstanceRow, InstanceStore } from './store.js';
import { readProfile, type ProcessProfile } from '../profile/read.js';
import { StubRunner } from '../runners/stub.js';
import { createDispatch, type RunnerSet } from './dispatch.js';

const SNAPSHOT_EVENTS = ['activity.start', 'activity.wait', 'activity.timer', 'activity.end'];

/** The dispatch hooks (extensions/scripts) and custom moddle exceed
 * bpmn-engine's published option types; cast at the engine boundary only. */
type EngineOptions = ConstructorParameters<typeof Engine>[0];

export interface EngineHostOptions {
  runners?: RunnerSet;
  dataDir?: string;
}

interface RunningEntry {
  engine: InstanceType<typeof Engine>;
  execution: any;
}

/** Placeholder runners for non-dry, no-runner hosts. Only invoked if the
 * source actually carries contracts; contract-less M1 fixtures never call them. */
function missingRunners(): RunnerSet {
  const fail = (kind: string) => ({
    async run(): Promise<never> {
      throw new Error(`no runner configured for ${kind} task`);
    },
  });
  return { agent: fail('agent'), code: fail('code') };
}

export class EngineHost {
  private running = new Map<string, RunningEntry>();
  private profiles = new Map<string, ProcessProfile>();

  constructor(private store: InstanceStore, private opts: EngineHostOptions = {}) {}

  /** Start a new instance. Resolves on completion or stop; rejects on engine error. */
  async start(opts: {
    id: string;
    name: string;
    source: string;
    workspace?: string;
    variables?: Record<string, unknown>;
    dryRun?: boolean;
    stubOverrides?: Record<string, Record<string, unknown>>;
  }): Promise<void> {
    this.store.createInstance(opts.id, opts.name, opts.source, {
      workspace: opts.workspace,
      dryRun: opts.dryRun,
      stubOverrides: opts.stubOverrides,
    });
    const row = this.store.getInstance(opts.id)!;
    const components = await this.engineComponents(row);
    // bpmn-engine's option types don't cover custom extensions/scripts hooks.
    const engine = new Engine({ name: opts.name, source: opts.source, ...components } as EngineOptions);
    await this.run(opts.id, engine, 'execute', opts.variables);
  }

  /** Recover and resume every non-terminal instance. Returns per-instance completion promises. */
  async resumeAll(): Promise<Array<{ id: string; completion: Promise<void> }>> {
    const rows = this.store.listNonTerminal().filter((row) => row.engineState !== null);
    const out: Array<{ id: string; completion: Promise<void> }> = [];
    for (const row of rows) {
      const components = await this.engineComponents(row);
      const engine = new Engine().recover(JSON.parse(row.engineState!), components as EngineOptions);
      this.store.setStatus(row.id, 'running');
      out.push({ id: row.id, completion: this.run(row.id, engine, 'resume') });
    }
    return out;
  }

  /** Stop all running engines (final state snapshot is taken by run()). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((entry) => entry.engine.stop()));
  }

  /** Resume a waiting user task, merging vars into process variables. */
  signal(instanceId: string, nodeId: string, vars: Record<string, unknown>): void {
    const entry = this.running.get(instanceId);
    if (!entry) throw new Error(`instance ${instanceId} is not running in this host`);
    // Signal vars must land in the process execution environment, same store as
    // task outputs (findings_m2-dispatch.md); the signal payload does not persist.
    const proc = this.runningProcess(entry.execution);
    Object.assign(proc.environment.variables, vars);
    entry.execution.signal({ id: nodeId });
  }

  private runningProcess(execution: any): { environment: { variables: Record<string, unknown> } } {
    for (const def of execution.definitions ?? []) {
      const procs = def.getRunningProcesses?.() ?? [];
      if (procs.length > 0) return procs[0];
    }
    throw new Error('no running process to signal');
  }

  private async engineComponents(row: InstanceRow) {
    const profile = await readProfile(row.source);
    this.profiles.set(row.id, profile);
    const overrides = row.stubOverrides ? JSON.parse(row.stubOverrides) : {};
    const runners: RunnerSet = row.dryRun
      ? { agent: new StubRunner(overrides), code: new StubRunner(overrides) }
      : this.opts.runners ?? missingRunners();
    const { extensions, scripts } = createDispatch({
      instanceId: row.id,
      workspace: row.workspace,
      dataDir: this.opts.dataDir ?? os.tmpdir(),
      profile,
      runners,
    });
    return { extensions, scripts, moddleOptions: { flowfabric: flowfabricModdle } };
  }

  private async run(
    id: string,
    engine: InstanceType<typeof Engine>,
    mode: 'execute' | 'resume',
    variables?: Record<string, unknown>,
  ): Promise<void> {
    const listener = new EventEmitter();
    // getState() is async; serialize snapshots so writes never interleave.
    let queue: Promise<void> = Promise.resolve();
    const snapshot = () => {
      queue = queue
        .then(async () => {
          const state = await engine.getState();
          this.store.saveEngineState(id, JSON.stringify(state));
        })
        .catch(() => {});
    };
    for (const event of SNAPSHOT_EVENTS) {
      listener.on(event, (api: { id: string }) => {
        this.store.appendEvent(id, event, api.id);
        snapshot();
      });
    }

    const outcome = new Promise<'end' | 'stop'>((resolve, reject) => {
      engine.once('end', () => resolve('end'));
      engine.once('stop', () => resolve('stop'));
      engine.once('error', reject);
    });

    try {
      const execution =
        mode === 'execute'
          ? await engine.execute({ listener, variables })
          : await engine.resume({ listener });
      this.running.set(id, { engine, execution });
      const result = await outcome;
      await queue;
      const state = await engine.getState();
      this.store.saveEngineState(id, JSON.stringify(state));
      this.store.setStatus(id, result === 'end' ? 'completed' : 'stopped');
      this.store.appendEvent(id, `engine.${result}`);
    } catch (err) {
      await queue;
      this.store.setStatus(id, 'error');
      this.store.appendEvent(id, 'engine.error', undefined, String(err));
      throw err;
    } finally {
      this.running.delete(id);
    }
  }
}
