import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { InstanceStore } from './engine-host/store.js';
import { EngineHost } from './engine-host/engine-host.js';
import type { RunnerSet } from './engine-host/dispatch.js';
import { Inbox } from './inbox/inbox.js';
import type { Notifier } from './notify/notifier.js';
import { DefinitionStore } from './definitions/store.js';
import { GrillHost } from './grill/session.js';
import type { AgentQueryFn } from './runners/agent.js';
import { LogRing } from './logs/ring.js';
import { buildApi } from './api/server.js';
import { NOOP_TELEMETRY, type Telemetry } from './telemetry/telemetry.js';

/**
 * Composition root: wires the full Daemon graph. Defaults are inert — no-op
 * notifier, stub-runner dry-run path, NOOP telemetry, no grill queryFn — so a
 * bare `createDaemon({ dataDir })` can never notify, call the SDK, or export
 * telemetry. The entrypoint (daemon.ts) is the one place that injects the
 * production adapters.
 */
export interface DaemonOptions {
  dataDir: string;
  runners?: RunnerSet;
  notifier?: Notifier;
  telemetry?: Telemetry;
  grillQueryFn?: AgentQueryFn;
  webRoot?: string;
}

export interface Daemon {
  store: InstanceStore;
  host: EngineHost;
  inbox: Inbox;
  definitions: DefinitionStore;
  grill: GrillHost;
  logRing: LogRing;
  app: FastifyInstance;
  telemetry: Telemetry;
  close(): Promise<void>;
}

export function createDaemon(opts: DaemonOptions): Daemon {
  const { dataDir } = opts;
  fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });
  const dbPath = path.join(dataDir, 'flow-fabric.db');

  const telemetry = opts.telemetry ?? NOOP_TELEMETRY;
  // Deliberate asymmetry: the store only gets telemetry when one was injected —
  // passing NOOP_TELEMETRY would make every terminal setStatus pay the
  // payload-assembly SELECTs for spans nobody exports.
  const store = new InstanceStore(dbPath, opts.telemetry ? { telemetry: opts.telemetry } : {});
  const definitions = new DefinitionStore(dbPath);
  const notifier: Notifier = opts.notifier ?? { notify: async () => {} };
  // two-phase wiring: inbox needs host, host needs inbox's handleWait
  let inbox!: Inbox;
  const host = new EngineHost(store, {
    dataDir,
    notifier,
    onUserTaskWait: (info) => inbox.handleWait(info),
    ...(opts.runners ? { runners: opts.runners } : {}),
  });
  inbox = new Inbox(store, host, notifier);
  // Without an explicit queryFn, GrillSession would fall back to the live SDK
  // — an inert daemon must fail fast instead.
  const failFastQueryFn: AgentQueryFn = () => {
    throw new Error('no grill queryFn configured — inject one via createDaemon({ grillQueryFn })');
  };
  const grill = new GrillHost({ definitions, queryFn: opts.grillQueryFn ?? failFastQueryFn });
  const logRing = new LogRing();
  const app = buildApi({ store, host, inbox, definitions, grill, logRing, webRoot: opts.webRoot });

  return {
    store,
    host,
    inbox,
    definitions,
    grill,
    logRing,
    app,
    telemetry,
    async close() {
      await host.stopAll();
      await app.close();
      await telemetry.shutdown();
      // Stores close only after stopAll: an in-flight engine write racing a
      // closed DB was the M4 unhandled-rejection finding.
      store.close();
      definitions.close();
    },
  };
}
