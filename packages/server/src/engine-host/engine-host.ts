import { EventEmitter } from 'node:events';
import { Engine } from 'bpmn-engine';
import type { InstanceStore } from './store.js';

const SNAPSHOT_EVENTS = ['activity.start', 'activity.wait', 'activity.timer', 'activity.end'];

export class EngineHost {
  private running = new Map<string, InstanceType<typeof Engine>>();

  constructor(private store: InstanceStore) {}

  /** Start a new instance. Resolves on completion or stop; rejects on engine error. */
  async start(opts: {
    id: string;
    name: string;
    source: string;
    variables?: Record<string, unknown>;
  }): Promise<void> {
    this.store.createInstance(opts.id, opts.name, opts.source);
    const engine = new Engine({ name: opts.name, source: opts.source });
    await this.run(opts.id, engine, 'execute', opts.variables);
  }

  /** Recover and resume every non-terminal instance. Returns per-instance completion promises. */
  resumeAll(): Array<{ id: string; completion: Promise<void> }> {
    return this.store
      .listNonTerminal()
      .filter((row) => row.engineState !== null)
      .map((row) => {
        const engine = new Engine().recover(JSON.parse(row.engineState!));
        this.store.setStatus(row.id, 'running');
        return { id: row.id, completion: this.run(row.id, engine, 'resume') };
      });
  }

  /** Stop all running engines (final state snapshot is taken by run()). */
  async stopAll(): Promise<void> {
    await Promise.all([...this.running.values()].map((engine) => engine.stop()));
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

    this.running.set(id, engine);
    try {
      if (mode === 'execute') await engine.execute({ listener, variables });
      else await engine.resume({ listener });
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
