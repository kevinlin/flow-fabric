import { describe, it, expect } from 'vitest';
import { parseLogLine } from '../src/lib/logs';

describe('parseLogLine', () => {
  it('parses a pino JSON line', () => {
    const p = parseLogLine('{"level":30,"time":1700000000000,"msg":"server listening"}');
    expect(p).toEqual({ level: 'info', msg: 'server listening', time: 1700000000000 });
  });
  it('falls back to raw text for non-JSON', () => {
    const p = parseLogLine('plain log line');
    expect(p.msg).toBe('plain log line');
    expect(p.level).toBe('info');
  });
});
