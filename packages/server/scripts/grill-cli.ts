/** Interactive grill session in the terminal (M3.5 gate; the M4 web UI replaces this).
 * Usage: node --env-file-if-exists=../../.env --import tsx scripts/grill-cli.ts <file.bpmn> [--db <path>]
 * Commands inside the session: /lint  /save  /quit — anything else is a chat message. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost } from '../src/grill/session.js';

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error('usage: grill-cli.ts <file.bpmn> [--db <path>]');
  process.exit(1);
}
const dbFlag = rest.indexOf('--db');
const dbPath = dbFlag !== -1 ? rest[dbFlag + 1] : path.join(os.homedir(), '.flow-fabric', 'flow-fabric.db');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const definitions = new DefinitionStore(dbPath);
const { id } = definitions.upload(path.basename(file, '.bpmn'), fs.readFileSync(file, 'utf8'));
const host = new GrillHost({ definitions });
const session = await host.start(id);
console.log(`definition ${id}, lint: ${session.lintReport.errorCount} error(s), ` +
  `${session.lintReport.findings.length - session.lintReport.errorCount} warning(s)`);

session.onEvent((event) => {
  if (event.type === 'chat' && event.message.type === 'assistant') {
    const blocks = (event.message.message as any)?.content ?? [];
    for (const b of blocks) if (b.type === 'text') console.log(`\n[grill] ${b.text}`);
  } else if (event.type === 'op-applied') {
    for (const d of event.diff) console.log(`  [op] ${d.summary}`);
  } else if (event.type === 'lint-updated') {
    console.log(`  [lint] ${event.report.errorCount} error(s), deployable=${event.report.deployable}`);
  } else if (event.type === 'op-rejected') {
    console.log(`  [rejected] ${event.error}`);
  } else if (event.type === 'error') {
    console.error(`  [error] ${event.error}`);
  }
});

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
for (;;) {
  const line = (await rl.question('\nyou> ')).trim();
  if (line === '/quit') break;
  if (line === '/lint') {
    console.log(JSON.stringify(session.lintReport, null, 2));
    continue;
  }
  if (line === '/save') {
    const { versionNo, deployable } = session.saveVersion();
    console.log(`saved version ${versionNo} (deployable=${deployable})`);
    continue;
  }
  if (line) await session.send(line);
}
rl.close();
definitions.close();
