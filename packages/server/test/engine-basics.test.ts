import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { Engine } from 'bpmn-engine';
import { describe, it, expect } from 'vitest';

const source = readFileSync(new URL('./fixtures/basic.bpmn', import.meta.url), 'utf8');

describe('bpmn-engine basics', () => {
  it('executes the fixture to completion and reports transitions', async () => {
    const engine = new Engine({ name: 'basic', source });
    const listener = new EventEmitter();
    const transitions: string[] = [];
    for (const ev of ['activity.start', 'activity.end']) {
      listener.on(ev, (api: { id: string }) => transitions.push(`${ev}:${api.id}`));
    }
    const ended = new Promise<void>((resolve, reject) => {
      engine.once('end', () => resolve());
      engine.once('error', reject);
    });
    await engine.execute({ listener });
    await ended;

    expect(transitions).toContain('activity.start:start');
    expect(transitions).toContain('activity.end:inc');
    expect(transitions).toContain('activity.end:end');

    const state = await engine.getState();
    expect(state.state).toBe('idle');
  });
});
