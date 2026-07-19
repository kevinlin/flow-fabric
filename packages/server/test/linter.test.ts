import { readFileSync, existsSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LINT_RULES, type LintReport } from '@flowfabric/shared';
import { lint } from '../src/linter/lint.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');
const refined = readFileSync(new URL('./fixtures/daily-loop-refined.bpmn', import.meta.url), 'utf8');
const RFP_PATH = new URL('../../../Input/bpmn/rfp-daily-routine.bpmn', import.meta.url);
const INTERVIEW_PATH = new URL('../../../Input/bpmn/interview-process.bpmn', import.meta.url);

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"
             xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
             xmlns:flowfabric="http://flowfabric.dev/schema/1.0"
             id="d" targetNamespace="http://flowfabric.dev/spike">`;
const wrap = (body: string) => `${HEAD}<process id="p" isExecutable="true">${body}</process></definitions>`;

function byRule(report: LintReport, rule: string) {
  return report.findings.filter((f) => f.rule === rule);
}

describe('lint rule 1 — unsupported elements (FF001)', () => {
  it('flags generic tasks on the messy fixture', async () => {
    const report = await lint(messy);
    const ids = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).map((f) => f.nodeId);
    expect(ids).toContain('checkTracker');
    expect(ids).toContain('notify');
    expect(report.deployable).toBe(false);
  });

  it('flags parallel gateways and timeCycle timers', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="pg" />
      <parallelGateway id="pg" />
      <sequenceFlow id="f2" sourceRef="pg" targetRef="cycle" />
      <intermediateCatchEvent id="cycle">
        <timerEventDefinition><timeCycle xsi:type="tFormalExpression">R/PT24H</timeCycle></timerEventDefinition>
      </intermediateCatchEvent>
      <sequenceFlow id="f3" sourceRef="cycle" targetRef="end" />
      <endEvent id="end" />`));
    const ids = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).map((f) => f.nodeId);
    expect(ids).toContain('pg');
    expect(ids).toContain('cycle'); // timeDuration only (M1 finding)
  });

  it('accepts every profile element on the contracted fixture', async () => {
    const report = await lint(contracts);
    expect(byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT)).toEqual([]);
  });

  it('returns a single FF001 error for unparseable XML instead of throwing', async () => {
    const report = await lint('not xml at all');
    expect(report.errorCount).toBe(1);
    expect(report.findings[0].rule).toBe(LINT_RULES.UNSUPPORTED_ELEMENT);
  });
});

describe('lint rule 2 — missing contracts (FF002)', () => {
  it('flags serviceTask without prompt/outputSchema, scriptTask without command, userTask without formSchema', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc" name="Agent w/o contract" />
      <sequenceFlow id="f2" sourceRef="svc" targetRef="scr" />
      <scriptTask id="scr" name="Code w/o command" />
      <sequenceFlow id="f3" sourceRef="scr" targetRef="usr" />
      <userTask id="usr" name="Human w/o form" />
      <sequenceFlow id="f4" sourceRef="usr" targetRef="end" />
      <endEvent id="end" />`));
    const ids = byRule(report, LINT_RULES.MISSING_CONTRACT).map((f) => f.nodeId);
    expect(ids).toEqual(expect.arrayContaining(['svc', 'scr', 'usr']));
  });

  it('flags an outputSchema that is not valid JSON', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>do things</flowfabric:prompt>
            <flowfabric:outputSchema>{broken</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="end" />
      <endEvent id="end" />`));
    expect(byRule(report, LINT_RULES.MISSING_CONTRACT).map((f) => f.nodeId)).toContain('svc');
  });

  it('passes the fully contracted fixture', async () => {
    const report = await lint(contracts);
    expect(byRule(report, LINT_RULES.MISSING_CONTRACT)).toEqual([]);
  });
});

describe('lint rule 3 — gateway conditions (FF003)', () => {
  it('flags prose-labelled flows without conditions on the messy fixture', async () => {
    const report = await lint(messy);
    const ids = byRule(report, LINT_RULES.UNEVALUABLE_CONDITION).map((f) => f.nodeId);
    expect(ids).toEqual(expect.arrayContaining(['flowYes', 'flowNo']));
  });

  it('accepts javascript conditions plus one default flow', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.x === true));
        </conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });

  it('rejects non-javascript condition formats (a ${...} body would crash the scripts hook)', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression">\${environment.variables.x}</conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION).map((f) => f.nodeId)).toContain('toA');
  });

  it('ignores single-outgoing gateways (pure joins)', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="join" />
      <exclusiveGateway id="join" />
      <sequenceFlow id="f2" sourceRef="join" targetRef="end" />
      <endEvent id="end" />`));
    expect(byRule(report, LINT_RULES.UNEVALUABLE_CONDITION)).toEqual([]);
  });
});

describe('lint rule 4 — undeclared variables (FF004)', () => {
  it('flags an input no upstream task produces and no instance input declares', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:input name="deadline" type="string" />
            <flowfabric:outputSchema>{"type":"object","properties":{"ok":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="end" />
      <endEvent id="end" />`));
    const found = byRule(report, LINT_RULES.UNDECLARED_VARIABLE);
    expect(found.map((f) => f.nodeId)).toContain('svc');
    expect(found[0].message).toContain('deadline');
  });

  it('accepts variables produced upstream, declared as instance inputs, or referenced by conditions', async () => {
    const report = await lint(wrap(`
      <extensionElements>
        <flowfabric:instanceInputs><flowfabric:input name="deadline" type="string" /></flowfabric:instanceInputs>
      </extensionElements>
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="svc" />
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:input name="deadline" type="string" />
            <flowfabric:outputSchema>{"type":"object","properties":{"atRisk":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="endA">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.atRisk === true));
        </conditionExpression>
      </sequenceFlow>
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNDECLARED_VARIABLE)).toEqual([]);
  });

  it('flags a condition variable produced only downstream of the gateway', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="gw" />
      <exclusiveGateway id="gw" default="toB" />
      <sequenceFlow id="toA" sourceRef="gw" targetRef="svc">
        <conditionExpression xsi:type="tFormalExpression" language="javascript">
          const environment = this.environment; next(null, Boolean(environment.variables.atRisk === true));
        </conditionExpression>
      </sequenceFlow>
      <serviceTask id="svc">
        <extensionElements>
          <flowfabric:agentTask>
            <flowfabric:prompt>audit</flowfabric:prompt>
            <flowfabric:outputSchema>{"type":"object","properties":{"atRisk":{"type":"boolean"}}}</flowfabric:outputSchema>
          </flowfabric:agentTask>
        </extensionElements>
      </serviceTask>
      <sequenceFlow id="f2" sourceRef="svc" targetRef="endA" />
      <sequenceFlow id="toB" sourceRef="gw" targetRef="endB" />
      <endEvent id="endA" /><endEvent id="endB" />`));
    expect(byRule(report, LINT_RULES.UNDECLARED_VARIABLE).map((f) => f.nodeId)).toContain('gw');
  });
});

describe('lint rule 5 — orphan nodes (FF005)', () => {
  it('flags nodes unreachable from the start event', async () => {
    const report = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="end" />
      <endEvent id="end" />
      <userTask id="orphan" name="Old step">
        <extensionElements>
          <flowfabric:userTask><flowfabric:formSchema>{"type":"object"}</flowfabric:formSchema></flowfabric:userTask>
        </extensionElements>
      </userTask>`));
    expect(byRule(report, LINT_RULES.ORPHAN_NODE).map((f) => f.nodeId)).toEqual(['orphan']);
  });

  it('treats boundary events and their handler paths as reachable', async () => {
    const report = await lint(contracts.replace(
      '<endEvent id="end" />',
      `<endEvent id="end" />
       <boundaryEvent id="guard" attachedToRef="agentTask"><errorEventDefinition /></boundaryEvent>
       <sequenceFlow id="fErr" sourceRef="guard" targetRef="endErr" />
       <endEvent id="endErr" />`,
    ));
    expect(byRule(report, LINT_RULES.ORPHAN_NODE)).toEqual([]);
  });
});

describe('lint rule 6 — instruction-bearing labels (FF006)', () => {
  it('warns on "do not re-run" / "ends here" labels without blocking deployment', async () => {
    const report = await lint(messy);
    const found = byRule(report, LINT_RULES.INSTRUCTION_LABEL);
    expect(found.map((f) => f.nodeId)).toContain('endStop');
    expect(found.every((f) => f.severity === 'warning')).toBe(true);
  });
});

describe('readable messages + auto-fix suggestions', () => {
  it('names nodes by their label, not the raw id, and keeps no id in the message', async () => {
    const report = await lint(messy);
    const gen = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).find((f) => f.nodeId === 'checkTracker')!;
    expect(gen.nodeName).toBe('Check the tracker');
    expect(gen.message).not.toContain('checkTracker');
    expect(gen.message).not.toContain('sid-');
    expect(report.findings.every((f) => !f.message.includes('sid-'))).toBe(true);
  });

  it('attaches a one-click suggestion to grill-fixable findings', async () => {
    const report = await lint(messy);
    const gen = byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT).find((f) => f.nodeId === 'checkTracker')!;
    expect(gen.suggestion).toContain('Assign an actor');
    expect(gen.suggestion).toContain('Check the tracker');

    const cond = byRule(report, LINT_RULES.UNEVALUABLE_CONDITION).find((f) => f.nodeId === 'flowYes')!;
    expect(cond.nodeName).toBe('Yes');
    expect(cond.suggestion).toContain('At risk?'); // the gateway label, resolved from its name
    expect(cond.suggestion).toContain('condition');

    const label = byRule(report, LINT_RULES.INSTRUCTION_LABEL).find((f) => f.nodeId === 'endStop')!;
    expect(label.suggestion).toContain('terminate end event');
  });

  it('omits the suggestion for editor-only findings (orphans, structural FF001)', async () => {
    const orphaned = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="end" />
      <endEvent id="end" />
      <userTask id="orphan" name="Old step">
        <extensionElements>
          <flowfabric:userTask><flowfabric:formSchema>{"type":"object"}</flowfabric:formSchema></flowfabric:userTask>
        </extensionElements>
      </userTask>`));
    const orphan = byRule(orphaned, LINT_RULES.ORPHAN_NODE).find((f) => f.nodeId === 'orphan')!;
    expect(orphan.nodeName).toBe('Old step');
    expect(orphan.suggestion).toBeUndefined();

    const parallel = await lint(wrap(`
      <startEvent id="start" />
      <sequenceFlow id="f1" sourceRef="start" targetRef="pg" />
      <parallelGateway id="pg" name="Fork" />
      <sequenceFlow id="f2" sourceRef="pg" targetRef="end" />
      <endEvent id="end" />`));
    const pg = byRule(parallel, LINT_RULES.UNSUPPORTED_ELEMENT).find((f) => f.nodeId === 'pg')!;
    expect(pg.suggestion).toBeUndefined();
  });
});

describe('lint verdicts on whole files (impl M3.2 verify)', () => {
  it('hand-refined daily-loop fixture is deployable', async () => {
    const report = await lint(refined);
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.deployable).toBe(true);
  });

  it.skipIf(!existsSync(RFP_PATH))('raw rfp-daily fails with generic-task, condition, and label findings', async () => {
    const report = await lint(readFileSync(RFP_PATH, 'utf8'));
    expect(report.deployable).toBe(false);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules).toContain(LINT_RULES.UNSUPPORTED_ELEMENT);   // 19 generic <task> elements
    expect(rules).toContain(LINT_RULES.UNEVALUABLE_CONDITION); // prose gateway labels ("Yes"/"No")
    expect(rules).toContain(LINT_RULES.INSTRUCTION_LABEL);     // "Task Ends Here Do No Re-Run"
  });

  it.skipIf(!existsSync(INTERVIEW_PATH))('interview-process lints: no unsupported elements, but contracts and conditions missing', async () => {
    const report = await lint(readFileSync(INTERVIEW_PATH, 'utf8'));
    expect(report.deployable).toBe(false);
    const rules = new Set(report.findings.map((f) => f.rule));
    expect(rules).toContain(LINT_RULES.MISSING_CONTRACT);      // 13 userTasks without formSchema
    expect(rules).toContain(LINT_RULES.UNEVALUABLE_CONDITION); // 6 gateways without conditions
    expect(byRule(report, LINT_RULES.UNSUPPORTED_ELEMENT)).toEqual([]); // userTasks + terminate ends are profile elements
  });
});
