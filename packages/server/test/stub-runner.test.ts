import { describe, it, expect } from 'vitest';
import { StubRunner } from '../src/runners/stub.js';
import { validateOutput, OutputValidationError } from '../src/runners/validate.js';
import type { AgentTaskContract } from '@flowfabric/shared';

function agentContract(schema: Record<string, unknown>): AgentTaskContract {
  return {
    kind: 'agent', retries: 0, timeoutSeconds: 60,
    prompt: 'p', tools: [], inputs: [], outputSchema: schema,
  };
}

const ctx = {
  instanceId: 'i1', nodeId: 'n1', workspace: '/tmp',
  attempt: 1, signal: new AbortController().signal, dataDir: '/tmp',
};

describe('StubRunner', () => {
  it('derives schema-conforming fake output', async () => {
    const schema = {
      type: 'object',
      required: ['atRiskTasks', 'count', 'ok', 'mode'],
      properties: {
        atRiskTasks: { type: 'array', items: { type: 'string' } },
        count: { type: 'number' },
        ok: { type: 'boolean' },
        mode: { type: 'string', enum: ['fast', 'slow'] },
      },
    };
    const { output } = await new StubRunner().run(agentContract(schema), {}, ctx);
    expect(() => validateOutput(schema, output)).not.toThrow();
    expect(output).toEqual({ atRiskTasks: [], count: 0, ok: false, mode: 'fast' });
  });

  it('per-node overrides win over derivation', async () => {
    const schema = {
      type: 'object', required: ['count'],
      properties: { count: { type: 'number' } },
    };
    const stub = new StubRunner({ n1: { count: 7 } });
    const { output } = await stub.run(agentContract(schema), {}, ctx);
    expect(output).toEqual({ count: 7 });
  });
});

describe('validateOutput', () => {
  it('throws OutputValidationError with details on schema mismatch', () => {
    const schema = { type: 'object', required: ['x'], properties: { x: { type: 'number' } } };
    expect(() => validateOutput(schema, { x: 'nope' })).toThrow(OutputValidationError);
    try {
      validateOutput(schema, {});
    } catch (err) {
      expect(String(err)).toContain('x');
    }
  });
});
