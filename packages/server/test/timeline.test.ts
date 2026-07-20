import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, it, expect, afterEach } from 'vitest';
import { createDaemon, type Daemon } from '../src/compose.js';
import type { RunResult, TaskRunner } from '../src/runners/types.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const failure = readFileSync(new URL('./fixtures/failure.bpmn', import.meta.url), 'utf8');

const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

describe('task_executions timeline (FR-14)', () => {
  const daemons: Daemon[] = [];
  afterEach(async () => {
    for (const d of daemons.splice(0)) await d.close();
  });

  it('records every step of a dry run with inputs, outputs, timing, actor', async () => {
    const d = createDaemon({ dataDir: tmp() });
    daemons.push(d);
    const { store, host, inbox } = d;

    const running = host.start({
      id: 't1', name: 'contracts', source: contracts, workspace: tmp(),
      dryRun: true, variables: { deadline: '2026-08-01' },
      stubOverrides: { codeTask: { count: 5 } },
    });
    for (let i = 0; i < 100 && inbox.listPending().length === 0; i++) await sleep(100);
    await inbox.submit(inbox.listPending()[0].id, { approved: true });
    await running;

    const rows = store.listTaskExecutions('t1');
    expect(rows.map((r) => [r.nodeId, r.actor, r.status])).toEqual([
      ['agentTask', 'agent', 'completed'],
      ['codeTask', 'code', 'completed'],
      ['userTask', 'user', 'completed'],
    ]);
    expect(JSON.parse(rows[0].resolvedInputs)).toEqual({ deadline: '2026-08-01' });
    expect(JSON.parse(rows[1].output!)).toEqual({ count: 5 });
    expect(JSON.parse(rows[2].output!)).toEqual({ approved: true });
    for (const row of rows) {
      expect(row.attempt).toBe(1);
      expect(row.endedAt).toBeGreaterThanOrEqual(row.startedAt);
    }
  });

  it('records one row per attempt, failed attempts with the error', async () => {
    let calls = 0;
    const flaky: TaskRunner = {
      async run(): Promise<RunResult> {
        calls += 1;
        if (calls === 1) throw new Error('induced');
        return { output: { ok: true }, costUsd: 0.02, tokenUsage: { output_tokens: 9 } };
      },
    };
    const d = createDaemon({ dataDir: tmp(), runners: { agent: flaky, code: flaky } });
    daemons.push(d);
    const { store, host } = d;
    await host.start({ id: 't2', name: 'failure', source: failure, workspace: tmp() });

    const rows = store.listTaskExecutions('t2');
    expect(rows.map((r) => [r.attempt, r.status])).toEqual([
      [1, 'failed'],
      [2, 'completed'],
    ]);
    expect(rows[0].error).toContain('induced');
    expect(rows[1].costUsd).toBe(0.02);
    expect(JSON.parse(rows[1].tokenUsage!)).toEqual({ output_tokens: 9 });
  });
});
