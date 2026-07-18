import { readFileSync } from 'node:fs';
import { BpmnModdle } from 'bpmn-moddle';
import { describe, it, expect } from 'vitest';
import { flowfabricModdle } from '../src/profile/descriptor.js';

const xml = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

function moddle() {
  return new BpmnModdle({ flowfabric: flowfabricModdle });
}

// Extension elements land in extensionElements.values (moddle Element instances).
function extensionOf(el: any, typeName: string): any {
  return el.extensionElements?.values?.find((v: any) => v.$type === typeName);
}

describe('flowfabric moddle descriptor', () => {
  it('parses agent, code, and user contracts from the fixture', async () => {
    const { rootElement } = await moddle().fromXML(xml);
    const process = rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const byId = new Map(process.flowElements.map((e: any) => [e.id, e]));

    const agent = extensionOf(byId.get('agentTask'), 'flowfabric:AgentTask');
    expect(agent.retries).toBe(2);
    expect(agent.timeoutSeconds).toBe(600);
    expect(agent.prompt.text).toContain('Audit');
    expect(agent.tools.text).toBe('Read,Grep,Glob');
    expect(agent.inputs.map((i: any) => i.name)).toEqual(['deadline']);
    expect(JSON.parse(agent.outputSchema.text).required).toEqual(['atRiskTasks']);

    const code = extensionOf(byId.get('codeTask'), 'flowfabric:CodeTask');
    expect(code.command).toBe('node check.js');
    expect(JSON.parse(code.outputSchema.text).type).toBe('object');

    const user = extensionOf(byId.get('userTask'), 'flowfabric:UserTask');
    expect(JSON.parse(user.formSchema.text).properties.approved.type).toBe('boolean');
  });

  it('round-trips: serialize and re-parse with contracts intact', async () => {
    const m = moddle();
    const parsed = await m.fromXML(xml);
    const { xml: reXml } = await m.toXML(parsed.rootElement, { format: true });
    const again = await moddle().fromXML(reXml);
    const process = again.rootElement.rootElements.find((e: any) => e.$type === 'bpmn:Process');
    const agentTask = process.flowElements.find((e: any) => e.id === 'agentTask');
    const agent = extensionOf(agentTask, 'flowfabric:AgentTask');
    expect(agent.prompt.text).toContain('Audit');
    expect(reXml).toContain('http://flowfabric.dev/schema/1.0');
  });
});
