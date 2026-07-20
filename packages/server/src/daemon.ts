import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDaemon } from './compose.js';
import { sdkQueryFn } from './grill/session.js';
import { MacNotifier } from './notify/notifier.js';
import { AgentRunner } from './runners/agent.js';
import { CodeRunner } from './runners/code.js';
import { initTelemetry } from './telemetry/telemetry.js';

const dataDir = process.env.FF_DATA_DIR ?? path.join(os.homedir(), '.flow-fabric');
const port = Number(process.env.FF_PORT ?? 4400);
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');

// The one place that injects production adapters; everything else about the
// graph lives in the composition root (compose.ts).
const daemon = createDaemon({
  dataDir,
  runners: { agent: new AgentRunner(), code: new CodeRunner() },
  notifier: new MacNotifier(),
  telemetry: initTelemetry(),
  grillQueryFn: sdkQueryFn,
  webRoot,
});

const resumed = await daemon.host.resumeAll();
for (const { id, completion } of resumed) {
  completion.catch((err) => console.error(`[flow-fabric] resumed instance ${id} failed:`, err));
}
await daemon.app.listen({ port, host: '127.0.0.1' });
console.log(`[flow-fabric] daemon on http://127.0.0.1:${port} — data dir ${dataDir}, resumed ${resumed.length} instance(s)`);
console.log(`[flow-fabric] OTel export ${daemon.telemetry.enabled ? 'enabled' : 'disabled'}`);

// Graceful shutdown (launchd sends SIGTERM). Durability does NOT depend on
// this — every transition is already snapshotted (M1: SIGKILL-safe) and
// resumeAll() recovers on next boot.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    void (async () => {
      console.log(`[flow-fabric] ${sig} — stopping engines, flushing telemetry`);
      await daemon.close();
      process.exit(0);
    })();
  });
}
