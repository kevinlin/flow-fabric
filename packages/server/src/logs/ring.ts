/** Bounded in-memory log buffer. Acts as a pino stream: pino calls write(chunk). */
export class LogRing {
  private buf: string[] = [];
  constructor(private capacity = 500) {}

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      this.buf.push(trimmed);
      if (this.buf.length > this.capacity) this.buf.shift();
    }
  }

  /** Newest-last. `limit` returns the most recent `limit` lines. */
  lines(limit?: number): string[] {
    return limit === undefined ? [...this.buf] : this.buf.slice(-limit);
  }
}
