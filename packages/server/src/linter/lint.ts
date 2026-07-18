import { BpmnModdle } from 'bpmn-moddle';
import {
  flowfabricModdle,
  LINT_RULES,
  type LintFinding,
  type LintReport,
} from '@flowfabric/shared';

/** Structural elements that carry no execution semantics — allowed and ignored. */
const PASSIVE_TYPES = new Set([
  'bpmn:Collaboration', 'bpmn:Participant', 'bpmn:LaneSet', 'bpmn:Lane',
  'bpmn:TextAnnotation', 'bpmn:Association', 'bpmn:Group', 'bpmn:Category',
]);

const SUPPORTED_MESSAGE =
  'supported: start/end events (incl. terminate), exclusive gateways, user/script/service tasks, ' +
  'duration timer intermediate catch events, error boundary events (FR-6)';

function finding(
  rule: LintFinding['rule'],
  severity: LintFinding['severity'],
  message: string,
  nodeId?: string,
): LintFinding {
  return { rule, severity, message, ...(nodeId ? { nodeId } : {}) };
}

function report(findings: LintFinding[]): LintReport {
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return { findings, errorCount, deployable: errorCount === 0 };
}

function defs(el: any): any[] {
  return el.eventDefinitions ?? [];
}

/** Deterministic deployability gate (FR-3, design §4.3). Pure; never throws. */
export async function lint(xml: string): Promise<LintReport> {
  const moddle = new BpmnModdle({ flowfabric: flowfabricModdle });
  let rootElement: any;
  try {
    ({ rootElement } = await moddle.fromXML(xml));
  } catch (err) {
    return report([
      finding(LINT_RULES.UNSUPPORTED_ELEMENT, 'error', `not parseable as BPMN 2.0: ${String(err)}`),
    ]);
  }

  const findings: LintFinding[] = [];
  for (const root of rootElement.rootElements ?? []) {
    if (root.$type === 'bpmn:Collaboration') {
      for (const mf of root.messageFlows ?? []) {
        findings.push(finding(
          LINT_RULES.UNSUPPORTED_ELEMENT, 'error',
          `message flows are not supported in v1; ${SUPPORTED_MESSAGE}`, mf.id,
        ));
      }
      continue;
    }
    if (root.$type !== 'bpmn:Process') continue;
    const elements: any[] = root.flowElements ?? [];
    ruleUnsupportedElements(elements, findings);
    ruleMissingContracts(elements, findings);
    ruleGatewayConditions(elements, findings);
    const graph = buildGraph(elements);
    ruleUndeclaredVariables(root, elements, graph, findings);
    ruleOrphanNodes(elements, graph, findings);
    ruleInstructionLabels(elements, findings);
  }
  return report(findings);
}

// Rule 1 (FF001): only profile elements may appear (FR-6).
function ruleUnsupportedElements(elements: any[], findings: LintFinding[]): void {
  const bad = (el: any, why: string) =>
    findings.push(finding(LINT_RULES.UNSUPPORTED_ELEMENT, 'error', `${why}; ${SUPPORTED_MESSAGE}`, el.id));

  for (const el of elements) {
    switch (el.$type) {
      case 'bpmn:SequenceFlow':
      case 'bpmn:ExclusiveGateway':
      case 'bpmn:UserTask':
      case 'bpmn:ScriptTask':
      case 'bpmn:ServiceTask':
        break;
      case 'bpmn:StartEvent':
        if (defs(el).length > 0) bad(el, `start event ${el.id} must be plain (no event definition)`);
        break;
      case 'bpmn:EndEvent': {
        const other = defs(el).filter((d: any) => d.$type !== 'bpmn:TerminateEventDefinition');
        if (other.length > 0) bad(el, `end event ${el.id} may only be plain or terminate`);
        break;
      }
      case 'bpmn:IntermediateCatchEvent': {
        const [def, ...rest] = defs(el);
        if (!def || rest.length > 0 || def.$type !== 'bpmn:TimerEventDefinition' || !def.timeDuration) {
          bad(el, `intermediate catch event ${el.id} must be a single timeDuration timer ` +
            `(timeCycle/timeDate fire once and break recurrence — M1 finding)`);
        }
        break;
      }
      case 'bpmn:BoundaryEvent': {
        const ok = defs(el).length === 1 && defs(el)[0].$type === 'bpmn:ErrorEventDefinition';
        if (!ok) bad(el, `boundary event ${el.id} must carry exactly one error event definition`);
        break;
      }
      default:
        if (!PASSIVE_TYPES.has(el.$type)) bad(el, `unsupported element ${el.$type} (${el.id})`);
    }
  }
}

// Rule 2 (FF002): every task carries its actor contract (FR-3).
function ruleMissingContracts(elements: any[], findings: LintFinding[]): void {
  const miss = (el: any, what: string) =>
    findings.push(finding(LINT_RULES.MISSING_CONTRACT, 'error', `${el.$type} ${el.id} ${what}`, el.id));
  const ext = (el: any, typeName: string) =>
    el.extensionElements?.values?.find((v: any) => v.$type === typeName);
  const jsonObject = (text: string | undefined) => {
    if (!text) return false;
    try {
      const parsed = JSON.parse(text);
      return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  };

  for (const el of elements) {
    if (el.$type === 'bpmn:ServiceTask') {
      const a = ext(el, 'flowfabric:AgentTask');
      if (!a) miss(el, 'is missing its flowfabric:agentTask contract');
      else {
        if (!a.prompt?.text?.trim()) miss(el, 'has no agent prompt');
        if (!jsonObject(a.outputSchema?.text)) miss(el, 'has no valid JSON outputSchema');
      }
    } else if (el.$type === 'bpmn:ScriptTask') {
      const c = ext(el, 'flowfabric:CodeTask');
      if (!c) miss(el, 'is missing its flowfabric:codeTask contract');
      else {
        if (!c.command?.trim()) miss(el, 'has no command');
        if (!jsonObject(c.outputSchema?.text)) miss(el, 'has no valid JSON outputSchema');
      }
    } else if (el.$type === 'bpmn:UserTask') {
      const u = ext(el, 'flowfabric:UserTask');
      if (!u || !jsonObject(u.formSchema?.text)) miss(el, 'has no valid JSON formSchema');
    }
  }
}

// Rule 3 (FF003): every branching gateway path is evaluable (FR-3, FR-8).
function ruleGatewayConditions(elements: any[], findings: LintFinding[]): void {
  const flows = elements.filter((el) => el.$type === 'bpmn:SequenceFlow');
  for (const gw of elements) {
    if (gw.$type !== 'bpmn:ExclusiveGateway') continue;
    const outgoing = flows.filter((f) => f.sourceRef?.id === gw.id);
    if (outgoing.length <= 1) continue;
    for (const flow of outgoing) {
      if (gw.default?.id === flow.id) continue; // the one allowed unconditioned path
      const ce = flow.conditionExpression;
      const evaluable = !!ce?.body?.trim() && ce.language?.toLowerCase() === 'javascript';
      if (!evaluable) {
        const label = flow.name ? ` (label: "${flow.name}")` : '';
        findings.push(finding(
          LINT_RULES.UNEVALUABLE_CONDITION, 'error',
          `flow ${flow.id} out of gateway ${gw.id}${label} needs a javascript conditionExpression ` +
            `over process variables, or must be the gateway's default flow`,
          flow.id,
        ));
      }
    }
  }
}

interface Graph {
  /** nodeId -> directly following nodeIds (sequence flows + host->boundary). */
  next: Map<string, string[]>;
  nodeIds: Set<string>;
}

function buildGraph(elements: any[]): Graph {
  const next = new Map<string, string[]>();
  const nodeIds = new Set<string>();
  const push = (from: string, to: string) => {
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  };
  for (const el of elements) {
    if (el.$type === 'bpmn:SequenceFlow') {
      if (el.sourceRef?.id && el.targetRef?.id) push(el.sourceRef.id, el.targetRef.id);
    } else if (!PASSIVE_TYPES.has(el.$type)) {
      nodeIds.add(el.id);
      // a boundary event is reachable whenever its host is
      if (el.$type === 'bpmn:BoundaryEvent' && el.attachedToRef?.id) push(el.attachedToRef.id, el.id);
    }
  }
  return { next, nodeIds };
}

function reachableFrom(graph: Graph, startIds: string[]): Set<string> {
  const seen = new Set<string>(startIds);
  const queue = [...startIds];
  while (queue.length > 0) {
    for (const to of graph.next.get(queue.shift()!) ?? []) {
      if (!seen.has(to)) {
        seen.add(to);
        queue.push(to);
      }
    }
  }
  return seen;
}

const CONDITION_VAR = /environment\.variables\.([A-Za-z_$][A-Za-z0-9_$]*)/g;

// Rule 4 (FF004): every consumed variable is produced strictly upstream or declared
// as an instance input (FR-3). "Upstream" = the consumer is reachable from the producer.
function ruleUndeclaredVariables(proc: any, elements: any[], graph: Graph, findings: LintFinding[]): void {
  const ext = (el: any, typeName: string) =>
    el.extensionElements?.values?.find((v: any) => v.$type === typeName);
  const schemaProps = (text: string | undefined): string[] => {
    try {
      return Object.keys(JSON.parse(text ?? '{}').properties ?? {});
    } catch {
      return [];
    }
  };

  const instanceInputs = new Set<string>(
    (ext(proc, 'flowfabric:InstanceInputs')?.inputs ?? []).map((i: any) => i.name),
  );

  const producers = new Map<string, string[]>(); // variable name -> producing node ids
  const produce = (name: string, nodeId: string) => {
    if (!producers.has(name)) producers.set(name, []);
    producers.get(name)!.push(nodeId);
  };
  for (const el of elements) {
    const contract = ext(el, 'flowfabric:AgentTask') ?? ext(el, 'flowfabric:CodeTask');
    if (contract) for (const p of schemaProps(contract.outputSchema?.text)) produce(p, el.id);
    const user = ext(el, 'flowfabric:UserTask');
    if (user) for (const p of schemaProps(user.formSchema?.text)) produce(p, el.id);
  }

  // consumers: declared task inputs + variables referenced in gateway conditions
  const consumers: Array<{ nodeId: string; variable: string }> = [];
  for (const el of elements) {
    const contract = ext(el, 'flowfabric:AgentTask') ?? ext(el, 'flowfabric:CodeTask');
    for (const input of contract?.inputs ?? []) consumers.push({ nodeId: el.id, variable: input.name });
    if (el.$type === 'bpmn:SequenceFlow' && el.conditionExpression?.body && el.sourceRef?.id) {
      for (const m of el.conditionExpression.body.matchAll(CONDITION_VAR)) {
        consumers.push({ nodeId: el.sourceRef.id, variable: m[1] });
      }
    }
  }

  const reachCache = new Map<string, Set<string>>();
  const reaches = (from: string, to: string) => {
    if (!reachCache.has(from)) reachCache.set(from, reachableFrom(graph, graph.next.get(from) ?? []));
    return reachCache.get(from)!.has(to);
  };

  const flagged = new Set<string>();
  for (const { nodeId, variable } of consumers) {
    if (instanceInputs.has(variable)) continue;
    const ok = (producers.get(variable) ?? []).some((p) => p !== nodeId && reaches(p, nodeId));
    const key = `${nodeId}:${variable}`;
    if (!ok && !flagged.has(key)) {
      flagged.add(key);
      findings.push(finding(
        LINT_RULES.UNDECLARED_VARIABLE, 'error',
        `variable "${variable}" used at ${nodeId} is not produced upstream and not declared as an instance input`,
        nodeId,
      ));
    }
  }
}

// Rule 5 (FF005): every flow node is reachable from a start event.
function ruleOrphanNodes(elements: any[], graph: Graph, findings: LintFinding[]): void {
  const startIds = elements.filter((el) => el.$type === 'bpmn:StartEvent').map((el) => el.id);
  const reachable = reachableFrom(graph, startIds);
  for (const id of graph.nodeIds) {
    if (!reachable.has(id)) {
      findings.push(finding(
        LINT_RULES.ORPHAN_NODE, 'error',
        `node ${id} is unreachable from any start event; no removeNode patch op exists — delete it in the source editor and re-upload`,
        id,
      ));
    }
  }
}

// Rule 6 (FF006): instruction-bearing labels belong in BPMN semantics, not prose.
const INSTRUCTION_LABEL = /(do\s+no?t?\s+re-?\s?run|ends?\s+here)/i;

function ruleInstructionLabels(elements: any[], findings: LintFinding[]): void {
  for (const el of elements) {
    if (el.$type === 'bpmn:SequenceFlow' || PASSIVE_TYPES.has(el.$type)) continue;
    if (typeof el.name === 'string' && INSTRUCTION_LABEL.test(el.name)) {
      findings.push(finding(
        LINT_RULES.INSTRUCTION_LABEL, 'warning',
        `label "${el.name}" on ${el.id} carries execution instructions; model it as a terminate end event or loop condition instead`,
        el.id,
      ));
    }
  }
}
