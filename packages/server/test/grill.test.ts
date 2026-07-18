import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DefinitionStore } from '../src/definitions/store.js';
import { GrillHost, type GrillEvent } from '../src/grill/session.js';
import type { AgentQueryFn } from '../src/runners/agent.js';
import type { PatchOp } from '../src/patch-ops/apply.js';

const messy = readFileSync(new URL('./fixtures/messy.bpmn', import.meta.url), 'utf8');
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'ff-spike-'));

/** Mock SDK transport: records calls, replays a scripted assistant turn. */
function mockQuery() {
  const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
  const queryFn: AgentQueryFn = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Which actor runs "Check the tracker"?' }] } };
      yield { type: 'result', subtype: 'success', result: 'asked', session_id: `s-${calls.length}` };
    })();
  };
  return { calls, queryFn };
}

describe('GrillSession', () => {
  const stores: DefinitionStore[] = [];
  afterEach(() => stores.forEach((s) => s.close()));

  async function openSession(queryFn?: AgentQueryFn) {
    const definitions = new DefinitionStore(path.join(tmp(), 'ff.db'));
    stores.push(definitions);
    const { id } = definitions.upload('messy', messy);
    const host = new GrillHost({ definitions, ...(queryFn ? { queryFn } : {}) });
    return { definitions, defId: id, session: await host.start(id), host };
  }

  // The exact op sequence a live grill would propose for messy.bpmn. Reused by the
  // scripted-session verify (impl M3.4): messy -> deployable without manual XML edits.
  const REFINEMENT_OPS: PatchOp[][] = [
    [{ op: 'setTaskType', nodeId: 'checkTracker', bpmnType: 'bpmn:ServiceTask' },
     { op: 'setTaskContract', nodeId: 'checkTracker', contract: {
       kind: 'agent', retries: 1, timeoutSeconds: 120, prompt: 'Check the tracker for at-risk tasks.',
       tools: ['Read', 'Grep'], inputs: [{ name: 'deadline', type: 'string' }],
       outputSchema: { type: 'object', required: ['atRisk'], properties: { atRisk: { type: 'boolean' } } },
     } }],
    [{ op: 'setTaskType', nodeId: 'notify', bpmnType: 'bpmn:ScriptTask' },
     { op: 'setTaskContract', nodeId: 'notify', contract: {
       kind: 'code', retries: 0, timeoutSeconds: 30, command: 'node notify.js',
       inputs: [], outputSchema: { type: 'object', required: ['notified'], properties: { notified: { type: 'boolean' } } },
     } }],
    [{ op: 'setGatewayCondition', flowId: 'flowYes', expression: 'environment.variables.atRisk === true' },
     { op: 'setGatewayCondition', flowId: 'flowNo', isDefault: true, expression: '' }],
    [{ op: 'replaceLabel', nodeId: 'endStop', newLabel: 'At-risk path handled' },
     { op: 'convertToTerminateEnd', nodeId: 'endStop' }],
    [{ op: 'declareInstanceInput', name: 'deadline', type: 'string' }],
  ];

  it('starts with the uploaded xml and a failing lint report', async () => {
    const { session } = await openSession();
    expect(session.xml).toBe(messy);
    expect(session.lintReport.deployable).toBe(false);
  });

  it('scripted refinement drives messy.bpmn to deployable, emitting op + lint events (impl M3.4 verify)', async () => {
    const { session } = await openSession();
    const events: GrillEvent[] = [];
    session.onEvent((e) => events.push(e));

    let errorsBefore = session.lintReport.errorCount;
    for (const batch of REFINEMENT_OPS) {
      const { report } = await session.applyOps(batch);
      expect(report.errorCount).toBeLessThanOrEqual(errorsBefore);
      errorsBefore = report.errorCount;
    }
    expect(session.lintReport.deployable).toBe(true);
    expect(events.filter((e) => e.type === 'op-applied')).toHaveLength(REFINEMENT_OPS.length);
    expect(events.filter((e) => e.type === 'lint-updated')).toHaveLength(REFINEMENT_OPS.length);
  });

  it('rejected ops leave the working copy and report untouched', async () => {
    const { session } = await openSession();
    const before = session.xml;
    await expect(session.applyOps([{ op: 'replaceLabel', nodeId: 'ghost', newLabel: 'x' }]))
      .rejects.toThrow();
    expect(session.xml).toBe(before);
  });

  it('send() passes the diagram + lint briefing on turn 1, resumes the SDK session on turn 2', async () => {
    const { calls, queryFn } = mockQuery();
    const { session } = await openSession(queryFn);
    const events: GrillEvent[] = [];
    session.onEvent((e) => events.push(e));

    await session.send('Let us start');
    expect(calls[0].prompt).toContain('propose_patch_ops');
    expect(calls[0].prompt).toContain('<process');           // diagram is in the briefing
    expect(calls[0].prompt).toContain('FF001');              // lint findings are in the briefing
    expect(calls[0].options.resume).toBeUndefined();
    expect((calls[0].options.allowedTools as string[])).toContain('mcp__flowfabric__propose_patch_ops');

    await session.send('Continue');
    expect(calls[1].options.resume).toBe('s-1');
    expect(events.filter((e) => e.type === 'chat').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((e) => e.type === 'turn-done')).toHaveLength(2);
  });

  it('saveVersion persists the working copy with its lint report (FR-4)', async () => {
    const { session, definitions, defId } = await openSession();
    for (const batch of REFINEMENT_OPS) await session.applyOps(batch);
    const { versionNo, deployable } = session.saveVersion();
    expect(versionNo).toBe(2);
    expect(deployable).toBe(true);
    const v2 = definitions.getVersion(defId, 2)!;
    expect(v2.deployable).toBe(true);
    expect(v2.xml).toBe(session.xml);
    expect(definitions.getVersion(defId, 1)!.xml).toBe(messy); // v1 immutable
  });
});
