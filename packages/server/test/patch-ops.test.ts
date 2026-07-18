import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LINT_RULES } from '@flowfabric/shared';
import { applyPatchOps, PatchOpError } from '../src/patch-ops/apply.js';
import { readProfile } from '../src/profile/read.js';
import { lint } from '../src/linter/lint.js';

const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');

describe('applyPatchOps — in-place ops', () => {
  it('setTaskContract writes an agent contract readable by readProfile', async () => {
    const { xml, diff } = await applyPatchOps(contracts, [{
      op: 'setTaskContract',
      nodeId: 'agentTask',
      contract: {
        kind: 'agent', retries: 3, timeoutSeconds: 120,
        prompt: 'New prompt', tools: ['Read'], boundaries: 'Stay in docs/',
        inputs: [{ name: 'deadline', type: 'string' }],
        outputSchema: { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } },
      },
    }]);
    const profile = await readProfile(xml);
    const contract = profile.contracts.get('agentTask');
    expect(contract).toMatchObject({ kind: 'agent', retries: 3, prompt: 'New prompt', tools: ['Read'] });
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ op: 'setTaskContract', target: 'agentTask' });
  });

  it('setTaskContract rejects a contract kind that does not match the element type', async () => {
    await expect(applyPatchOps(contracts, [{
      op: 'setTaskContract', nodeId: 'agentTask',
      contract: { kind: 'user', formSchema: { type: 'object' } },
    }])).rejects.toThrow(PatchOpError);
  });

  it('setGatewayCondition writes a javascript condition that clears FF003, and isDefault sets the default flow', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
      { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' },
    ]);
    expect(xml).toContain('language="javascript"');
    expect(xml).toContain('default="flowNo"');
    const report = await lint(xml);
    expect(report.findings.filter((f) => f.rule === LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });

  it('replaceLabel renames a node', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'At-risk path handled' },
    ]);
    expect(xml).toContain('At-risk path handled');
    expect(xml).not.toContain('Task ends here do not re-run');
  });

  it('setTimerDefinition rewrites a duration', async () => {
    const timer = readFileSync(new URL('./fixtures/loop.bpmn', import.meta.url), 'utf8');
    const { xml } = await applyPatchOps(timer, [
      { op: 'setTimerDefinition', nodeId: 'wait', iso8601: 'PT24H' },
    ]);
    expect(xml).toContain('PT24H');
  });

  it('declareInstanceInput adds a process-level instance input readable by readProfile', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'declareInstanceInput', name: 'submissionDeadline', type: 'string' },
    ]);
    const profile = await readProfile(xml);
    expect(profile.instanceInputs).toEqual([{ name: 'submissionDeadline', type: 'string' }]);
  });

  it('throws PatchOpError for an unknown node and leaves ops atomic (no partial result)', async () => {
    await expect(applyPatchOps(messy, [
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'x' },
      { op: 'replaceLabel', nodeId: 'nope', newLabel: 'y' },
    ])).rejects.toThrow(PatchOpError);
  });

  it('an empty op list round-trips contracts intact (baseline for DI comparisons)', async () => {
    const { xml, diff } = await applyPatchOps(contracts, []);
    expect(diff).toEqual([]);
    const profile = await readProfile(xml);
    expect(profile.contracts.get('agentTask')?.kind).toBe('agent');
  });
});
