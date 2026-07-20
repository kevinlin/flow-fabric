import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('SSE event vocabulary', () => {
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close();
  });

  it('emits usertask.created and usertask.submitted', async () => {
    const d = createDaemon({ dataDir: tmp() });
    daemons.push(d);
    const { store, host, inbox } = d;
    const completion = host.start({ id: 'i1', name: 'c', source: contracts, workspace: tmp(), dryRun: true, variables: { deadline: 'x' } });

    let task: ReturnType<typeof inbox.listPending>[number] | undefined;
    for (let i = 0; i < 100 && !task; i++) { task = inbox.listPending()[0]; if (!task) await sleep(50); }
    expect(store.listEvents('i1').some((e) => e.type === 'usertask.created')).toBe(true);

    await inbox.submit(task!.id, { approved: true });
    expect(store.listEvents('i1').some((e) => e.type === 'usertask.submitted')).toBe(true);
    await completion; // let the engine finish before afterEach closes the store
  });
});
