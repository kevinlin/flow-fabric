import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

export type AgentQueryFn = (args: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncIterable<Record<string, unknown>>;

export function extractJson(text: string): Record<string, unknown> {
  const candidates = [text.trim()];
  const fenced = text.match(/```json\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next candidate */
    }
  }
  throw new Error(`no JSON object found in agent output: ${text.slice(0, 200)}`);
}

function buildPrompt(contract: AgentTaskContract, inputs: Record<string, unknown>): string {
  return [
    contract.prompt,
    contract.boundaries ? `Boundaries:\n${contract.boundaries}` : '',
    `Inputs:\n${JSON.stringify(inputs, null, 2)}`,
    'End your final message with a single JSON object matching this JSON Schema — no prose after it:',
    JSON.stringify(contract.outputSchema),
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface ResultMessage {
  type: 'result';
  subtype: string;
  result?: string;
  session_id: string;
  usage?: unknown;
  total_cost_usd?: number;
  errors?: string[];
}

export class AgentRunner implements TaskRunner {
  constructor(private queryFn: AgentQueryFn = query as unknown as AgentQueryFn) {}

  async run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    if (contract.kind !== 'agent') throw new Error('AgentRunner only handles agent tasks');

    const dir = path.join(ctx.dataDir, 'transcripts', ctx.instanceId);
    mkdirSync(dir, { recursive: true });
    const transcriptPath = path.join(dir, `${ctx.nodeId}.${ctx.attempt}.jsonl`);
    const transcript = createWriteStream(transcriptPath, { flags: 'a' });

    const abortController = new AbortController();
    ctx.signal.addEventListener('abort', () => abortController.abort(ctx.signal.reason), { once: true });
    const baseOptions: Record<string, unknown> = {
      cwd: ctx.workspace,
      allowedTools: contract.tools,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      maxTurns: 50,
      abortController,
    };

    try {
      const first = await this.runSession(buildPrompt(contract, inputs), baseOptions, transcript);
      let costUsd = first.total_cost_usd ?? 0;
      let tokenUsage = first.usage;
      try {
        return { output: extractJson(first.result ?? ''), tokenUsage, costUsd, transcriptPath };
      } catch {
        // One in-attempt retry (design §6.1): resume the session and ask for JSON only.
        const second = await this.runSession(
          'Your previous reply did not end with the required JSON object. Reply with ONLY that JSON object now.',
          { ...baseOptions, resume: first.session_id },
          transcript,
        );
        costUsd += second.total_cost_usd ?? 0;
        tokenUsage = second.usage ?? tokenUsage;
        return { output: extractJson(second.result ?? ''), tokenUsage, costUsd, transcriptPath };
      }
    } finally {
      // Flush and close the transcript before returning so callers can read it.
      await new Promise<void>((resolve) => transcript.end(resolve));
    }
  }

  private async runSession(
    prompt: string,
    options: Record<string, unknown>,
    transcript: WriteStream,
  ): Promise<ResultMessage> {
    let result: ResultMessage | undefined;
    for await (const message of this.queryFn({ prompt, options })) {
      transcript.write(`${JSON.stringify(message)}\n`);
      if (message.type === 'result') result = message as unknown as ResultMessage;
    }
    if (!result) throw new Error('agent session ended without a result message');
    if (result.subtype !== 'success') {
      throw new Error(`agent session failed (${result.subtype}): ${(result.errors ?? []).join('; ')}`);
    }
    return result;
  }
}
