import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { InstanceStore } from '../src/engine-host/store.js';
import { EngineHost } from '../src/engine-host/engine-host.js';
import { Inbox } from '../src/inbox/inbox.js';
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

function build(dbPath: string, notifier: MockNotifier) {
  const store = new InstanceStore(dbPath);
  // two-phase wiring: inbox needs host, host needs inbox's handleWait
  let inbox!: Inbox;
  const host = new EngineHost(store, {
    dataDir: path.dirname(dbPath),
    onUserTaskWait: (info) => inbox.handleWait(info),
  });
  inbox = new Inbox(store, host, notifier);
  return { store, host, inbox };
}

async function waitForPending(inbox: Inbox, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (inbox.listPending().length >= count) return;
    await sleep(100);
  }
  throw new Error('timed out waiting for pending user task');
}

describe('user task service', () => {
  const stores: InstanceStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  it('creates a pending row and notifies when a user task waits', async () => {
    const notifier = new MockNotifier();
    const { store, host, inbox } = build(path.join(tmp(), 'ff.db'), notifier);
    stores.push(store);

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
    const { store, host, inbox } = build(path.join(tmp(), 'ff.db'), notifier);
    stores.push(store);

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
    const dbPath = path.join(tmp(), 'ff.db');
    const notifier1 = new MockNotifier();
    const first = build(dbPath, notifier1);
    stores.push(first.store);

    const running = first.host.start({ id: 'u3', name: 'contracts', source, workspace: tmp(), dryRun: true });
    await waitForPending(first.inbox);
    await first.host.stopAll();
    await running;
    first.store.close();

    const notifier2 = new MockNotifier();
    const second = build(dbPath, notifier2);
    stores.push(second.store);
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
