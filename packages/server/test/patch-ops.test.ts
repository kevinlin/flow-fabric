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

import { existsSync } from 'node:fs';
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);

/** The <bpmndi:...> section of a serialized file. Compared across two outputs of
 * applyPatchOps so both sides share identical serializer formatting. */
function diSection(xml: string): string {
  const start = xml.indexOf('<bpmndi:');
  const end = xml.lastIndexOf('</bpmndi:BPMNDiagram>');
  if (start === -1 || end === -1) throw new Error('no DI section');
  return xml.slice(start, end);
}

describe('applyPatchOps — structural ops', () => {
  it('setTaskType retypes a generic task and re-points flows, lanes, and DI', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
    ]);
    expect(xml).toContain('serviceTask');
    // flows still reference the node
    expect(xml).toMatch(/sourceRef="checkTracker"/);
    expect(xml).toMatch(/targetRef="checkTracker"/);
    // DI shape still references the node
    expect(xml).toContain('bpmnElement="checkTracker"');
  });

  it('setTaskType keeps existing extensionElements (contract survives retype)', async () => {
    const first = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
      { op: 'setTaskContract', nodeId: 'checkTracker', contract: {
        kind: 'agent', retries: 0, timeoutSeconds: 60, prompt: 'check', tools: ['Read'],
        inputs: [], outputSchema: { type: 'object', properties: { atRisk: { type: 'boolean' } } },
      } },
    ]);
    const profile = await readProfile(first.xml);
    expect(profile.contracts.get('checkTracker')?.kind).toBe('agent');
  });

  it('convertToTerminateEnd adds a terminate definition to an end event', async () => {
    const { xml } = await applyPatchOps(messy, [{ op: 'convertToTerminateEnd', nodeId: 'endStop' }]);
    const profile = await readProfile(xml);
    expect(profile.terminateEnds).toEqual(new Set(['endStop']));
  });

  it('convertToTerminateEnd rejects a node with outgoing flows', async () => {
    await expect(applyPatchOps(messy, [{ op: 'convertToTerminateEnd', nodeId: 'checkTracker' }]))
      .rejects.toThrow(PatchOpError);
  });

  it('addErrorBoundary attaches a boundary + handler flow and registers in the profile', async () => {
    const { xml } = await applyPatchOps(messy, [
      { op: 'addErrorBoundary', nodeId: 'notify', targetId: 'endOk' },
    ]);
    const profile = await readProfile(xml);
    expect(profile.errorBoundaryHosts).toEqual(new Set(['notify']));
    // boundary got its own DI shape so stock editors still render the file
    expect(xml).toContain('bpmnElement="Boundary_notify"');
  });

  it('in-place ops leave the DI section byte-identical (risk #3)', async () => {
    const base = await applyPatchOps(messy, []);
    const patched = await applyPatchOps(messy, [
      { op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
      { op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
      { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' },
      { op: 'replaceLabel', nodeId: 'endStop', newLabel: 'Handled' },
      { op: 'convertToTerminateEnd', nodeId: 'endStop' },
      { op: 'declareInstanceInput', name: 'deadline', type: 'string' },
    ]);
    expect(diSection(patched.xml)).toBe(diSection(base.xml));
  });

  it.skipIf(!existsSync(RFP_PATH))('real Signavio export: retype + label ops leave DI untouched', async () => {
    const raw = readFileSync(RFP_PATH, 'utf8');
    const base = await applyPatchOps(raw, []);
    // pick a generic task id out of the parsed model rather than hardcoding Signavio sids
    const profileless = await lint(raw);
    const genericTaskId = profileless.findings.find(
      (f) => f.rule === LINT_RULES.UNSUPPORTED_ELEMENT && f.nodeId,
    )!.nodeId!;
    const patched = await applyPatchOps(raw, [
      { op: 'setTaskType', nodeId: genericTaskId, bpmnType: 'bpmn:ServiceTask' },
      { op: 'replaceLabel', nodeId: genericTaskId, newLabel: 'Retyped by patch-ops test' },
    ]);
    expect(diSection(patched.xml)).toBe(diSection(base.xml));
  });
});
