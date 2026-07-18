import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { readProfile } from '../src/profile/read.js';

const xml = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

describe('readProfile', () => {
  it('extracts one typed contract per task node', async () => {
    const { contracts } = await readProfile(xml);
    expect([...contracts.keys()].sort()).toEqual(['agentTask', 'codeTask', 'userTask']);

    const agent = contracts.get('agentTask');
    if (agent?.kind !== 'agent') throw new Error('expected agent contract');
    expect(agent.retries).toBe(2);
    expect(agent.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(agent.inputs).toEqual([{ name: 'deadline', type: 'string' }]);
    expect(agent.outputSchema.required).toEqual(['atRiskTasks']);
    expect(agent.boundaries).toContain('30_tracker');

    const code = contracts.get('codeTask');
    if (code?.kind !== 'code') throw new Error('expected code contract');
    expect(code.command).toBe('node check.js');

    const user = contracts.get('userTask');
    if (user?.kind !== 'user') throw new Error('expected user contract');
    expect((user.formSchema.properties as any).approved.type).toBe('boolean');
  });

  it('reports which activities have an attached error boundary', async () => {
    const withBoundary = xml.replace(
      '<endEvent id="end" />',
      `<boundaryEvent id="err" attachedToRef="codeTask"><errorEventDefinition /></boundaryEvent>
       <sequenceFlow id="fErr" sourceRef="err" targetRef="end2" />
       <endEvent id="end2" />
       <endEvent id="end" />`,
    );
    const { errorBoundaryHosts } = await readProfile(withBoundary);
    expect(errorBoundaryHosts.has('codeTask')).toBe(true);
    expect(errorBoundaryHosts.has('agentTask')).toBe(false);
  });

  it('reads instanceInputs and terminateEnds', async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="tDef" targetNamespace="http://flowfabric.dev/spike">
  <process id="p" isExecutable="true">
    <extensionElements>
      <flowfabric:instanceInputs>
        <flowfabric:input name="deadline" type="string" />
      </flowfabric:instanceInputs>
    </extensionElements>
    <startEvent id="start" />
    <sequenceFlow id="f1" sourceRef="start" targetRef="stop" />
    <endEvent id="stop"><terminateEventDefinition /></endEvent>
    <endEvent id="plainEnd" />
  </process>
</definitions>`;
    const profile = await readProfile(xml);
    expect(profile.instanceInputs).toEqual([{ name: 'deadline', type: 'string' }]);
    expect(profile.terminateEnds).toEqual(new Set(['stop']));
  });
});
