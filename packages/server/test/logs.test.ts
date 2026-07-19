import { describe, it, expect } from 'vitest';
import { LogRing } from '../src/logs/ring.js';

describe('LogRing', () => {
  it('keeps only the last N lines and returns newest-last', () => {
    const ring = new LogRing(3);
    for (const n of ['a', 'b', 'c', 'd']) ring.write(`${n}\n`);
    expect(ring.lines()).toEqual(['b', 'c', 'd']);
    expect(ring.lines(2)).toEqual(['c', 'd']);
  });

  it('splits multi-line writes and ignores blank lines', () => {
    const ring = new LogRing(10);
    ring.write('one\ntwo\n');
    ring.write('\n');
    ring.write('three\n');
    expect(ring.lines()).toEqual(['one', 'two', 'three']);
  });
});
