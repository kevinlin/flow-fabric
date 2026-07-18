// Usage: node --import tsx scripts/spike-child.ts <dbPath> <instanceId>
// Starts the timer fixture and runs until killed (or completion).
import { readFileSync } from 'node:fs';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';

const [dbPath, instanceId] = process.argv.slice(2);
if (!dbPath || !instanceId) throw new Error('usage: spike-child.ts <dbPath> <instanceId>');

const source = readFileSync(new URL('../test/fixtures/timer.bpmn', import.meta.url), 'utf8');
const store = new InstanceStore(dbPath);
const host = new EngineHost(store);

await host.start({ id: instanceId, name: 'timer', source });
store.close();
