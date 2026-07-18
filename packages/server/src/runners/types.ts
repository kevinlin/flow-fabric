import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';

export interface RunContext {
  instanceId: string;
  nodeId: string;
  workspace: string;
  attempt: number;
  signal: AbortSignal;
  dataDir: string;
}

export interface RunResult {
  output: Record<string, unknown>;
  tokenUsage?: unknown;
  costUsd?: number;
  transcriptPath?: string;
}

export interface TaskRunner {
  run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult>;
}
