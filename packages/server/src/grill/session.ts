import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { z } from 'zod';
import { query, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import type { LintReport } from '@flowfabric/shared';
import type { AgentQueryFn } from '../runners/agent.js';
import { lint } from '../linter/lint.js';
import { applyPatchOps, type PatchDiff, type PatchOp } from '../patch-ops/apply.js';
import type { DefinitionStore } from '../definitions/store.js';

export type GrillEvent =
  | { type: 'chat'; message: Record<string, unknown> }
  | { type: 'op-applied'; diff: PatchDiff[] }
  | { type: 'lint-updated'; report: LintReport }
  | { type: 'op-rejected'; error: string }
  | { type: 'turn-done' }
  | { type: 'error'; error: string };

export interface GrillDeps {
  definitions: DefinitionStore;
  queryFn?: AgentQueryFn;
}

const OP_CATALOG = `Available patch ops (the ONLY way to change the diagram — never output XML):
- {"op":"setTaskType","nodeId":"...","bpmnType":"bpmn:ServiceTask"|"bpmn:ScriptTask"|"bpmn:UserTask"}
  serviceTask = agent (Claude), scriptTask = deterministic code, userTask = human.
- {"op":"setTaskContract","nodeId":"...","contract":{...}} where contract is one of
  {"kind":"agent","retries":n,"timeoutSeconds":n,"prompt":"...","tools":["Read",...],"boundaries":"...","inputs":[{"name":"...","type":"..."}],"outputSchema":{JSON Schema}}
  {"kind":"code","retries":n,"timeoutSeconds":n,"command":"...","inputs":[...],"outputSchema":{...}}
  {"kind":"user","formSchema":{JSON Schema}}
- {"op":"setGatewayCondition","flowId":"...","expression":"environment.variables.<name> === ...","isDefault":false}
  expression is a JavaScript boolean over process variables; pass isDefault:true (empty expression) for the fallback flow.
- {"op":"replaceLabel","nodeId":"...","newLabel":"..."}
- {"op":"convertToTerminateEnd","nodeId":"..."} (end events or dead-end tasks)
- {"op":"addErrorBoundary","nodeId":"<task>","targetId":"<handler node>"}
- {"op":"setTimerDefinition","nodeId":"<timer event>","iso8601":"PT24H"}
- {"op":"declareInstanceInput","name":"...","type":"..."}
There is no removeNode op: if the lint report shows an orphan node (FF005), tell the user to
delete it in their BPMN editor and re-upload — do not try to patch around it.`;

function briefing(xml: string, report: LintReport): string {
  return [
    'You are the Flow Fabric refinement ("grilling") agent. A BPMN diagram was uploaded that is not yet',
    'executable. Walk the diagram node by node and interrogate the user to: assign each task an actor,',
    'write task contracts, convert prose gateway labels into evaluable conditions, and replace',
    'instruction-bearing labels with proper BPMN semantics (terminate ends, loop conditions).',
    'Ask focused questions, one node (or small group) at a time. Apply agreed changes by calling the',
    'propose_patch_ops tool; its result carries the applied diff and the fresh lint report - drive the',
    'error count to zero. Never print or edit XML yourself.',
    '',
    OP_CATALOG,
    '',
    `Current lint report:\n${JSON.stringify(report, null, 2)}`,
    '',
    `The diagram:\n${xml}`,
  ].join('\n');
}

export class GrillSession {
  readonly id = randomUUID();
  private emitter = new EventEmitter();
  private sdkSessionId: string | undefined;
  private currentXml: string;
  private report: LintReport;
  private queryFn: AgentQueryFn;

  private constructor(
    readonly definitionId: string,
    xml: string,
    report: LintReport,
    private definitions: DefinitionStore,
    queryFn: AgentQueryFn | undefined,
  ) {
    this.currentXml = xml;
    this.report = report;
    this.queryFn = queryFn ?? (query as unknown as AgentQueryFn);
  }

  static async open(definitionId: string, xml: string, deps: GrillDeps): Promise<GrillSession> {
    return new GrillSession(definitionId, xml, await lint(xml), deps.definitions, deps.queryFn);
  }

  get xml(): string {
    return this.currentXml;
  }

  get lintReport(): LintReport {
    return this.report;
  }

  onEvent(listener: (e: GrillEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private emit(event: GrillEvent): void {
    this.emitter.emit('event', event);
  }

  /** Deterministic core: apply ops, re-lint, emit. Called by the SDK tool handler
   * and directly by tests/CLI. Atomic - a failing op changes nothing. */
  async applyOps(ops: PatchOp[]): Promise<{ diff: PatchDiff[]; report: LintReport }> {
    try {
      const { xml, diff } = await applyPatchOps(this.currentXml, ops);
      this.currentXml = xml;
      this.report = await lint(xml);
      this.emit({ type: 'op-applied', diff });
      this.emit({ type: 'lint-updated', report: this.report });
      return { diff, report: this.report };
    } catch (err) {
      this.emit({ type: 'op-rejected', error: String(err) });
      throw err;
    }
  }

  /** One chat turn. First turn carries the briefing (diagram + lint + op catalog);
   * later turns resume the SDK session (design §7). */
  async send(text: string): Promise<void> {
    const server = createSdkMcpServer({
      name: 'flowfabric',
      version: '1.0.0',
      tools: [
        tool(
          'propose_patch_ops',
          'Apply typed BPMN patch operations to the working diagram. Returns the applied diff and the new lint report.',
          { ops: z.array(z.record(z.string(), z.unknown())) },
          async ({ ops }) => {
            try {
              const { diff, report } = await this.applyOps(ops as unknown as PatchOp[]);
              return { content: [{ type: 'text', text: JSON.stringify({ applied: diff, lint: report }) }] };
            } catch (err) {
              return { content: [{ type: 'text', text: `PATCH REJECTED: ${String(err)}` }], isError: true };
            }
          },
        ),
      ],
    });
    const options: Record<string, unknown> = {
      mcpServers: { flowfabric: server },
      allowedTools: ['mcp__flowfabric__propose_patch_ops'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: 30,
      ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
    };
    const prompt = this.sdkSessionId ? text : `${briefing(this.currentXml, this.report)}\n\nUser: ${text}`;
    try {
      for await (const message of this.queryFn({ prompt, options })) {
        this.emit({ type: 'chat', message });
        if (message.type === 'result' && typeof message.session_id === 'string') {
          this.sdkSessionId = message.session_id;
        }
      }
      this.emit({ type: 'turn-done' });
    } catch (err) {
      this.emit({ type: 'error', error: String(err) });
      throw err;
    }
  }

  /** Persist the working copy as the next immutable version (FR-4). */
  saveVersion(): { versionNo: number; deployable: boolean } {
    const versionNo = this.definitions.saveVersion(this.definitionId, this.currentXml, this.report);
    return { versionNo, deployable: this.report.deployable };
  }
}

/** The production queryFn: the live Claude Agent SDK. Injected explicitly by
 * the entrypoint — the composition root defaults to an inert thrower. */
export const sdkQueryFn = query as unknown as AgentQueryFn;

export class GrillHost {
  private sessions = new Map<string, GrillSession>();

  constructor(private deps: GrillDeps) {}

  async start(definitionId: string): Promise<GrillSession> {
    const version = this.deps.definitions.getLatestVersion(definitionId);
    if (!version) throw new Error(`no versions for definition ${definitionId}`);
    const session = await GrillSession.open(definitionId, version.xml, this.deps);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): GrillSession | undefined {
    return this.sessions.get(id);
  }
}
