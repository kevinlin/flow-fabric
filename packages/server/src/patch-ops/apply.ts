import { BpmnModdle } from 'bpmn-moddle';
import { flowfabricModdle, type TaskContract } from '@flowfabric/shared';

export type PatchOp =
  | { op: 'setTaskType'; nodeId: string; bpmnType: 'bpmn:UserTask' | 'bpmn:ScriptTask' | 'bpmn:ServiceTask' }
  | { op: 'setTaskContract'; nodeId: string; contract: TaskContract }
  | { op: 'setGatewayCondition'; flowId: string; expression: string; isDefault?: boolean }
  | { op: 'replaceLabel'; nodeId: string; newLabel: string }
  | { op: 'convertToTerminateEnd'; nodeId: string }
  | { op: 'addErrorBoundary'; nodeId: string; targetId: string }
  | { op: 'setTimerDefinition'; nodeId: string; iso8601: string }
  | { op: 'declareInstanceInput'; name: string; type: string };

export interface PatchDiff {
  op: string;
  target: string;
  summary: string;
}

export interface PatchResult {
  xml: string;
  diff: PatchDiff[];
}

/** Typed failure: unknown node, kind mismatch, unsupported target. The grill
 * returns the message to the agent as a rejected tool call. */
export class PatchOpError extends Error {}

const CONTRACT_HOST: Record<string, TaskContract['kind']> = {
  'bpmn:ServiceTask': 'agent',
  'bpmn:ScriptTask': 'code',
  'bpmn:UserTask': 'user',
};

const FLOWFABRIC_CONTRACT_TYPES = ['flowfabric:AgentTask', 'flowfabric:CodeTask', 'flowfabric:UserTask'];

/** Apply typed edit ops via moddle — never raw XML (design §7, risk #3).
 * All-or-nothing: any failing op rejects the whole call, nothing is serialized. */
export async function applyPatchOps(xml: string, ops: PatchOp[]): Promise<PatchResult> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  const parsed = await moddle.fromXML(xml);
  const definitions = parsed.rootElement;
  const diff: PatchDiff[] = [];
  for (const op of ops) diff.push(applyOne(moddle, definitions, op));
  const { xml: outXml } = await moddle.toXML(definitions, { format: true });
  return { xml: outXml, diff };
}

function processes(definitions: any): any[] {
  return (definitions.rootElements ?? []).filter((r: any) => r.$type === 'bpmn:Process');
}

function findElement(definitions: any, id: string): { proc: any; el: any } {
  for (const proc of processes(definitions)) {
    const el = (proc.flowElements ?? []).find((e: any) => e.id === id);
    if (el) return { proc, el };
  }
  throw new PatchOpError(`no flow element with id "${id}"`);
}

function ensureExtensionElements(moddle: any, el: any): any {
  if (!el.extensionElements) {
    el.extensionElements = moddle.create('bpmn:ExtensionElements', { values: [] });
    el.extensionElements.$parent = el;
  }
  el.extensionElements.values ??= [];
  return el.extensionElements;
}

function bodyEl(moddle: any, type: string, text: string): any {
  return moddle.create(type, { text });
}

function buildContractElement(moddle: any, contract: TaskContract): any {
  if (contract.kind === 'agent') {
    return moddle.create('flowfabric:AgentTask', {
      retries: contract.retries,
      timeoutSeconds: contract.timeoutSeconds,
      prompt: bodyEl(moddle, 'flowfabric:Prompt', contract.prompt),
      tools: bodyEl(moddle, 'flowfabric:Tools', contract.tools.join(',')),
      ...(contract.boundaries
        ? { boundaries: bodyEl(moddle, 'flowfabric:Boundaries', contract.boundaries) }
        : {}),
      inputs: contract.inputs.map((i) => moddle.create('flowfabric:Input', { name: i.name, type: i.type })),
      outputSchema: bodyEl(moddle, 'flowfabric:OutputSchema', JSON.stringify(contract.outputSchema)),
    });
  }
  if (contract.kind === 'code') {
    return moddle.create('flowfabric:CodeTask', {
      command: contract.command,
      retries: contract.retries,
      timeoutSeconds: contract.timeoutSeconds,
      inputs: contract.inputs.map((i) => moddle.create('flowfabric:Input', { name: i.name, type: i.type })),
      outputSchema: bodyEl(moddle, 'flowfabric:OutputSchema', JSON.stringify(contract.outputSchema)),
    });
  }
  return moddle.create('flowfabric:UserTask', {
    formSchema: bodyEl(moddle, 'flowfabric:FormSchema', JSON.stringify(contract.formSchema)),
  });
}

function applyOne(moddle: any, definitions: any, op: PatchOp): PatchDiff {
  switch (op.op) {
    case 'setTaskContract': {
      const { el } = findElement(definitions, op.nodeId);
      const expected = CONTRACT_HOST[el.$type];
      if (expected !== op.contract.kind) {
        throw new PatchOpError(
          `contract kind "${op.contract.kind}" does not fit ${el.$type} ${op.nodeId} (expected "${expected ?? 'none'}"); ` +
            `run setTaskType first`,
        );
      }
      const ext = ensureExtensionElements(moddle, el);
      // replace any previous flowfabric contract, keep foreign extensions (e.g. Signavio metadata)
      ext.values = ext.values.filter((v: any) => !FLOWFABRIC_CONTRACT_TYPES.includes(v.$type));
      const contractEl = buildContractElement(moddle, op.contract);
      contractEl.$parent = ext;
      ext.values.push(contractEl);
      return { op: op.op, target: op.nodeId, summary: `${op.contract.kind} contract set on ${op.nodeId}` };
    }
    case 'setGatewayCondition': {
      const { el: flow } = findElement(definitions, op.flowId);
      if (flow.$type !== 'bpmn:SequenceFlow') throw new PatchOpError(`${op.flowId} is not a sequence flow`);
      const gateway = flow.sourceRef;
      if (gateway?.$type !== 'bpmn:ExclusiveGateway') {
        throw new PatchOpError(`${op.flowId} does not leave an exclusive gateway`);
      }
      if (op.isDefault) {
        gateway.default = flow;
        delete flow.conditionExpression;
        return { op: op.op, target: op.flowId, summary: `${op.flowId} is now the default flow of ${gateway.id}` };
      }
      if (!op.expression.trim()) throw new PatchOpError(`empty condition expression for ${op.flowId}`);
      flow.conditionExpression = moddle.create('bpmn:FormalExpression', {
        language: 'javascript',
        body: `const environment = this.environment; next(null, Boolean(${op.expression}));`,
      });
      flow.conditionExpression.$parent = flow;
      if (gateway.default === flow) delete gateway.default;
      return { op: op.op, target: op.flowId, summary: `condition on ${op.flowId}: ${op.expression}` };
    }
    case 'replaceLabel': {
      const { el } = findElement(definitions, op.nodeId);
      const old = el.name ?? '';
      el.name = op.newLabel;
      return { op: op.op, target: op.nodeId, summary: `label "${old}" -> "${op.newLabel}"` };
    }
    case 'setTimerDefinition': {
      const { el } = findElement(definitions, op.nodeId);
      const timer = (el.eventDefinitions ?? []).find((d: any) => d.$type === 'bpmn:TimerEventDefinition');
      if (el.$type !== 'bpmn:IntermediateCatchEvent' || !timer) {
        throw new PatchOpError(`${op.nodeId} is not a timer intermediate catch event`);
      }
      timer.timeDuration = moddle.create('bpmn:FormalExpression', { body: op.iso8601 });
      timer.timeDuration.$parent = timer;
      delete timer.timeCycle;
      delete timer.timeDate;
      return { op: op.op, target: op.nodeId, summary: `timer ${op.nodeId} duration = ${op.iso8601}` };
    }
    case 'declareInstanceInput': {
      const [proc] = processes(definitions);
      if (!proc) throw new PatchOpError('no process in definitions');
      const ext = ensureExtensionElements(moddle, proc);
      let ii = ext.values.find((v: any) => v.$type === 'flowfabric:InstanceInputs');
      if (!ii) {
        ii = moddle.create('flowfabric:InstanceInputs', { inputs: [] });
        ii.$parent = ext;
        ext.values.push(ii);
      }
      ii.inputs ??= [];
      if (!ii.inputs.some((i: any) => i.name === op.name)) {
        ii.inputs.push(moddle.create('flowfabric:Input', { name: op.name, type: op.type }));
      }
      return { op: op.op, target: op.name, summary: `instance input ${op.name}: ${op.type}` };
    }
    case 'setTaskType':
    case 'convertToTerminateEnd':
    case 'addErrorBoundary':
      throw new PatchOpError(`op ${op.op} not implemented yet (Task 6)`);
    default: {
      const never: never = op;
      throw new PatchOpError(`unknown op ${JSON.stringify(never)}`);
    }
  }
}
