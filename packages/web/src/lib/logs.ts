const PINO_LEVELS: Record<number, string> = { 10: 'trace', 20: 'debug', 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };

export function parseLogLine(line: string): { level: string; msg: string; time: number | null } {
  try {
    const o = JSON.parse(line);
    return {
      level: PINO_LEVELS[o.level as number] ?? String(o.level ?? 'info'),
      msg: o.msg ?? line,
      time: typeof o.time === 'number' ? o.time : null,
    };
  } catch {
    return { level: 'info', msg: line, time: null };
  }
}
