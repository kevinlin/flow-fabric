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
