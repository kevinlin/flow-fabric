import os from 'node:os';
import path from 'node:path';
import { InstanceStore } from '../src/engine-host/store.js';
import { analyzeInstance } from '../src/soak/report.js';

const dataDir = process.env.FF_DATA_DIR ?? path.join(os.homedir(), '.flow-fabric');
const store = new InstanceStore(path.join(dataDir, 'flow-fabric.db'));
const now = Date.now();
const openIncidents = store.listOpenIncidents();
const pendingTasks = store.listPendingUserTasks();

const reports = store.listInstances().map((row) =>
  analyzeInstance(
    {
      id: row.id,
      name: row.name,
      status: row.status,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      events: store.listEvents(row.id).map((e) => ({ type: e.type, elementId: e.elementId, ts: e.ts })),
      openIncidents: openIncidents.filter((i) => i.instanceId === row.id).length,
      pendingUserTasks: pendingTasks.filter((t) => t.instanceId === row.id).length,
    },
    now,
  ),
);

for (const r of reports) {
  const age = r.lastEventAgeMs === null ? '-' : `${Math.round(r.lastEventAgeMs / 60_000)}m`;
  console.log(
    `${r.verdict.padEnd(13)} ${r.status.padEnd(10)} cycles=${String(r.cycles).padEnd(3)} ` +
      `last=${(r.lastEventType ?? '-').padEnd(20)} age=${age.padEnd(7)} ${r.name} (${r.id})`,
  );
}
const stalls = reports.filter((r) => r.verdict === 'SILENT-STALL').length;
const cycles = reports.reduce((sum, r) => sum + r.cycles, 0);
console.log(`\n${reports.length} instance(s), ${cycles} timer cycle(s), ${stalls} SILENT-STALL(s)`);
store.close();
process.exit(stalls > 0 ? 1 : 0);
