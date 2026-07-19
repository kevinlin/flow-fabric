import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InstanceStore } from './engine-host/store.js';
import { EngineHost } from './engine-host/engine-host.js';
import { Inbox } from './inbox/inbox.js';
import { MacNotifier } from './notify/notifier.js';
import { AgentRunner } from './runners/agent.js';
import { CodeRunner } from './runners/code.js';
import { DefinitionStore } from './definitions/store.js';
import { GrillHost } from './grill/session.js';
import { LogRing } from './logs/ring.js';
import { buildApi } from './api/server.js';
import { initTelemetry } from './telemetry/telemetry.js';

const dataDir = process.env.FF_DATA_DIR ?? path.join(os.homedir(), '.flow-fabric');
const port = Number(process.env.FF_PORT ?? 4400);
fs.mkdirSync(path.join(dataDir, 'transcripts'), { recursive: true });

const dbPath = path.join(dataDir, 'flow-fabric.db');
const telemetry = initTelemetry();
const store = new InstanceStore(dbPath, { telemetry });
const definitions = new DefinitionStore(dbPath);
const notifier = new MacNotifier();
let inbox!: Inbox;
const host = new EngineHost(store, {
  runners: { agent: new AgentRunner(), code: new CodeRunner() },
  dataDir,
  notifier,
  onUserTaskWait: (info) => inbox.handleWait(info),
});
inbox = new Inbox(store, host, notifier);
const grill = new GrillHost({ definitions });
const logRing = new LogRing();
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
const app = buildApi({ store, host, inbox, definitions, grill, logRing, webRoot });

const resumed = await host.resumeAll();
for (const { id, completion } of resumed) {
  completion.catch((err) => console.error(`[flow-fabric] resumed instance ${id} failed:`, err));
}
await app.listen({ port, host: '127.0.0.1' });
console.log(`[flow-fabric] daemon on http://127.0.0.1:${port} — data dir ${dataDir}, resumed ${resumed.length} instance(s)`);
console.log(`[flow-fabric] OTel export ${telemetry.enabled ? 'enabled' : 'disabled'}`);

// Graceful shutdown (launchd sends SIGTERM): flush telemetry and free the
// port. Durability does NOT depend on this — every transition is already
// snapshotted (M1: SIGKILL-safe) and resumeAll() recovers on next boot.
// The store is not closed explicitly: an in-flight engine write racing a
// closed DB was the M4 unhandled-rejection finding; process exit is safe.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void (async () => {
      console.log(`[flow-fabric] ${sig} — stopping engines, flushing telemetry`);
      await host.stopAll();
      await app.close();
      await telemetry.shutdown();
      process.exit(0);
    })();
  });
}
