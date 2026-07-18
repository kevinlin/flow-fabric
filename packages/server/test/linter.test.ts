import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { LINT_RULES, type LintReport } from '@flowfabric/shared';
import { lint } from '../src/linter/lint.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const contracts = readFileSync(new URL('./fixtures/contracts.bpmn', import.meta.url), 'utf8');

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
