import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';
import type { Inbox } from '../src/inbox/inbox.js';
import type { Notifier } from '../src/notify/notifier.js';

const source = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function tmp() {
  return mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
}

class MockNotifier implements Notifier {
  calls: Array<{ title: string; body: string }> = [];
  async notify(title: string, body: string) {
    this.calls.push({ title, body });
  }
}

const daemons: Daemon[] = [];
afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
});

function build(dataDir: string, notifier: MockNotifier) {
  const d = createDaemon({ dataDir, notifier });
  daemons.push(d);
  return d;
}

async function waitForPending(inbox: Inbox, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (inbox.listPending().length >= count) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for pending user task');
}

describe('user task service', () => {
  it('creates a pending row and notifies when a user task waits', async () => {
    const notifier = new MockNotifier();
    const { store, host, inbox } = build(tmp(), notifier);

    const running = host.start({ id: 'u1', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(inbox);

    const [pending] = inbox.listPending();
    expect(pending.instanceId).toBe('u1');
    expect(pending.nodeId).toBe('userTask');
    expect(JSON.parse(pending.formSchema).properties.approved.type).toBe('boolean');
    expect(notifier.calls).toHaveLength(1);
    expect(notifier.calls[0].body).toContain('userTask');

    await inbox.submit(pending.id, { approved: true });
    await running;
    expect(store.getInstance('u1')?.status).toBe('completed');
    expect(inbox.listPending()).toHaveLength(0);
  });

  it('rejects submissions that fail the form schema and keeps the task pending', async () => {
    const notifier = new MockNotifier();
    const { store, host, inbox } = build(tmp(), notifier);

    const running = host.start({ id: 'u2', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(inbox);
    const [pending] = inbox.listPending();

    await expect(inbox.submit(pending.id, { approved: 'yes' })).rejects.toThrow();
    expect(inbox.listPending()).toHaveLength(1);

    await inbox.submit(pending.id, { approved: false });
    await running;
    expect(store.getInstance('u2')?.status).toBe('completed');
  });

  it('does not duplicate the pending row or re-notify after a restart', async () => {
    const dir = tmp();
    const notifier1 = new MockNotifier();
    const first = build(dir, notifier1);

    const running = first.host.start({ id: 'u3', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(first.inbox);
    await first.host.stopAll();
    await running;
    await first.close();

    const notifier2 = new MockNotifier();
    const second = build(dir, notifier2);
    const resumed = await second.host.resumeAll();
    await sleep(500); // resume re-enters the wait state

    expect(second.inbox.listPending()).toHaveLength(1); // still exactly one
    expect(notifier2.calls).toHaveLength(0); // no re-notification

    const [pending] = second.inbox.listPending();
    await second.inbox.submit(pending.id, { approved: true });
    await Promise.all(resumed.map((r) => r.completion));
    expect(second.store.getInstance('u3')?.status).toBe('completed');
  });
});
