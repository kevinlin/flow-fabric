import { spawn } from 'node:child_process';
import type { AgentTaskContract, CodeTaskContract } from '@flowfabric/shared';
import type { RunContext, RunResult, TaskRunner } from './types.js';

export class CodeRunner implements TaskRunner {
  async run(
    contract: AgentTaskContract | CodeTaskContract,
    inputs: Record<string, unknown>,
    ctx: RunContext,
  ): Promise<RunResult> {
    if (contract.kind !== 'code') throw new Error('CodeRunner only handles code tasks');

    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const [key, value] of Object.entries(inputs)) {
      env[`FF_VAR_${key.toUpperCase()}`] = typeof value === 'string' ? value : JSON.stringify(value);
    }

    const child = spawn(contract.command, {
      cwd: ctx.workspace,
      env,
      shell: true,
      signal: ctx.signal, // Node kills the child when the signal aborts
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write(JSON.stringify(inputs));
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once('error', reject); // spawn failure or abort
      child.once('close', (code) => resolve(code ?? -1));
    });

    if (exitCode !== 0) {
      throw new Error(`command exited ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    }
    try {
      return { output: JSON.parse(stdout) as Record<string, unknown> };
    } catch {
      throw new Error(`stdout is not valid JSON: ${stdout.trim().slice(0, 200)}`);
    }
  }
}
