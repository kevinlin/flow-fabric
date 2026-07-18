import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { AgentRunner, extractJson } from '../src/runners/agent.js';
import type { AgentTaskContract } from '@flowfabric/shared';

const contract: AgentTaskContract = {
  kind: 'agent', retries: 0, timeoutSeconds: 600,
  prompt: 'Audit the tracker.', tools: ['Read', 'Grep'],
  boundaries: 'Never modify files outside 30_tracker/',
  inputs: [{ name: 'deadline', type: 'string' }],
  outputSchema: { type: 'object', required: ['atRiskTasks'], properties: { atRiskTasks: { type: 'array' } } },
};

function ctx() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));
  return {
    instanceId: 'i1', nodeId: 'agentTask',
    workspace: dir, attempt: 1,
    signal: new AbortController().signal, dataDir: dir,
  };
}

function resultMessage(text: string, sessionId = 's1') {
  return {
    type: 'result', subtype: 'success', session_id: sessionId,
    result: text, total_cost_usd: 0.01,
    usage: { input_tokens: 100, output_tokens: 50 },
  };
}

describe('AgentRunner (mock transport)', () => {
  it('builds prompt/options, extracts JSON, records transcript and usage', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const queryFn = (args: any) => {
      calls.push(args);
      return (async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'working...' }] } };
        yield resultMessage('Here you go:\n```json\n{"atRiskTasks":["t1"]}\n```');
      })();
    };
    const c = ctx();
    const result = await new AgentRunner(queryFn).run(contract, { deadline: '2026-08-01' }, c);

    expect(result.output).toEqual({ atRiskTasks: ['t1'] });
    expect(result.costUsd).toBe(0.01);
    expect(result.tokenUsage).toEqual({ input_tokens: 100, output_tokens: 50 });

    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toContain('Audit the tracker.');
    expect(calls[0].prompt).toContain('30_tracker');
    expect(calls[0].prompt).toContain('"deadline": "2026-08-01"');
    expect(calls[0].prompt).toContain('"atRiskTasks"');
    expect(calls[0].options.cwd).toBe(c.workspace);
    expect(calls[0].options.allowedTools).toEqual(['Read', 'Grep']);

    const transcript = readFileSync(result.transcriptPath!, 'utf8').trim().split('\n');
    expect(transcript).toHaveLength(2);
    expect(JSON.parse(transcript[1]).type).toBe('result');
  });

  it('retries JSON extraction once by resuming the session', async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const queryFn = (args: any) => {
      calls.push(args);
      return (async function* () {
        yield resultMessage(
          calls.length === 1 ? 'I did the audit, all good!' : '{"atRiskTasks":[]}',
          'sess-42',
        );
      })();
    };
    const result = await new AgentRunner(queryFn).run(contract, {}, ctx());
    expect(result.output).toEqual({ atRiskTasks: [] });
    expect(calls).toHaveLength(2);
    expect(calls[1].options.resume).toBe('sess-42');
  });

  it('throws when the SDK reports an error subtype', async () => {
    const queryFn = () =>
      (async function* () {
        yield { type: 'result', subtype: 'error_during_execution', errors: ['boom'], session_id: 's', total_cost_usd: 0, usage: {} };
      })();
    await expect(new AgentRunner(queryFn as any).run(contract, {}, ctx())).rejects.toThrow(/error_during_execution/);
  });
});

describe('extractJson', () => {
  it('parses bare JSON, fenced JSON, and embedded JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('text\n```json\n{"a":1}\n```\nmore')).toEqual({ a: 1 });
    expect(extractJson('prefix {"a":{"b":2}} ')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('no json here')).toThrow();
  });
});

// Live smoke test (impl M2.4 verify). Needs ANTHROPIC_API_KEY (+ optional
// ANTHROPIC_BASE_URL/ANTHROPIC_MODEL) exported, e.g.: set -a; source .env; set +a
describe.skipIf(!process.env.ANTHROPIC_API_KEY)('AgentRunner live smoke', () => {
  it('returns schema-conforming JSON from a real session', async () => {
    const live: AgentTaskContract = {
      kind: 'agent', retries: 0, timeoutSeconds: 120,
      prompt: 'Reply with the JSON object {"ok": true}. Do nothing else.',
      tools: [], inputs: [],
      outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
    };
    const result = await new AgentRunner().run(live, {}, ctx());
    expect(result.output).toEqual({ ok: true });
    expect(result.costUsd).toBeGreaterThan(0);
  }, 120_000);
});
