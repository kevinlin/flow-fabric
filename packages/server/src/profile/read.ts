import { BpmnModdle } from 'bpmn-moddle';
import {
  flowfabricModdle,
  type TaskContract,
  type InputDecl,
} from '@flowfabric/shared';

export interface ProcessProfile {
  contracts: Map<string, TaskContract>;
  errorBoundaryHosts: Set<string>;
}

const DEFAULT_RETRIES = 0;
const DEFAULT_TIMEOUT_S = 600;

function ext(el: any, typeName: string): any {
  return el.extensionElements?.values?.find((v: any) => v.$type === typeName);
}

function inputs(raw: any[]): InputDecl[] {
  return (raw ?? []).map((i) => ({ name: i.name, type: i.type ?? 'string' }));
}

export async function readProfile(xml: string): Promise<ProcessProfile> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  const { rootElement } = await moddle.fromXML(xml);
  const contracts = new Map<string, TaskContract>();
  const errorBoundaryHosts = new Set<string>();

  for (const root of (rootElement as any).rootElements ?? []) {
    if (root.$type !== 'bpmn:Process') continue;
    for (const el of root.flowElements ?? []) {
      if (el.$type === 'bpmn:ServiceTask') {
        const a = ext(el, 'flowfabric:AgentTask');
        if (!a) continue;
        contracts.set(el.id, {
          kind: 'agent',
          retries: a.retries ?? DEFAULT_RETRIES,
          timeoutSeconds: a.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
          prompt: a.prompt?.text ?? '',
          tools: (a.tools?.text ?? '').split(',').map((t: string) => t.trim()).filter(Boolean),
          boundaries: a.boundaries?.text,
          inputs: inputs(a.inputs),
          outputSchema: JSON.parse(a.outputSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:ScriptTask') {
        const c = ext(el, 'flowfabric:CodeTask');
        if (!c) continue;
        contracts.set(el.id, {
          kind: 'code',
          retries: c.retries ?? DEFAULT_RETRIES,
          timeoutSeconds: c.timeoutSeconds ?? DEFAULT_TIMEOUT_S,
          command: c.command ?? '',
          inputs: inputs(c.inputs),
          outputSchema: JSON.parse(c.outputSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:UserTask') {
        const u = ext(el, 'flowfabric:UserTask');
        if (!u) continue;
        contracts.set(el.id, {
          kind: 'user',
          formSchema: JSON.parse(u.formSchema?.text ?? '{}'),
        });
      } else if (el.$type === 'bpmn:BoundaryEvent') {
        const isError = (el.eventDefinitions ?? []).some(
          (d: any) => d.$type === 'bpmn:ErrorEventDefinition',
        );
        if (isError && el.attachedToRef?.id) errorBoundaryHosts.add(el.attachedToRef.id);
      }
    }
  }
  return { contracts, errorBoundaryHosts };
}
