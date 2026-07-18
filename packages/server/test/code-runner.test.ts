import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { CodeRunner } from '../src/runners/code.js';
import type { CodeTaskContract } from '@flowfabric/shared';

function contract(command: string): CodeTaskContract {
  return {
    kind: 'code', retries: 0, timeoutSeconds: 30, command,
    inputs: [{ name: 'deadline', type: 'string' }],
    outputSchema: { type: 'object' },
  };
}

function ctx(signal = new AbortController().signal) {
  return {
    instanceId: 'i1', nodeId: 'codeTask',
    workspace: mkdtempSync(path.join(os.tmpdir(), 'ff-spike-')),
    attempt: 1, signal, dataDir: os.tmpdir(),
  };
}

const runner = new CodeRunner();

describe('CodeRunner', () => {
  it('passes inputs via FF_VAR_* env and stdin, parses stdout JSON', async () => {
    const cmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{` +
      `console.log(JSON.stringify({fromEnv:process.env.FF_VAR_DEADLINE,fromStdin:JSON.parse(s).deadline,cwdOk:true}))})"`;
    const { output } = await runner.run(contract(cmd), { deadline: '2026-08-01' }, ctx());
    expect(output).toEqual({ fromEnv: '2026-08-01', fromStdin: '2026-08-01', cwdOk: true });
  });

  it('runs in the workspace directory', async () => {
    const c = ctx();
    const cmd = `node -e "console.log(JSON.stringify({cwd:process.cwd()}))"`;
    const { output } = await runner.run(contract(cmd), {}, c);
    // realpath both sides: macOS tmpdir is symlinked (/var → /private/var)
    const { realpathSync } = await import('node:fs');
    expect(realpathSync(output.cwd as string)).toBe(realpathSync(c.workspace));
  });

  it('rejects on non-zero exit with stderr in the message', async () => {
    const cmd = `node -e "console.error('kaput');process.exit(3)"`;
    await expect(runner.run(contract(cmd), {}, ctx())).rejects.toThrow(/exited 3.*kaput/s);
  });

  it('rejects on non-JSON stdout', async () => {
    const cmd = `node -e "console.log('not json')"`;
    await expect(runner.run(contract(cmd), {}, ctx())).rejects.toThrow(/not valid JSON/);
  });

  it('kills the child when the abort signal fires (timeout path)', async () => {
    const controller = new AbortController();
    const cmd = `node -e "setTimeout(()=>{},10000)"`;
    const pending = runner.run(contract(cmd), {}, ctx(controller.signal));
    setTimeout(() => controller.abort(new Error('task timed out')), 300);
    const started = Date.now();
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5000); // did not wait for the 10s child
  });
});
