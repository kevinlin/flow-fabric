import { describe, it, expect } from 'vitest';
import { messageToText } from '../src/lib/chat';

describe('messageToText', () => {
  it('extracts assistant text blocks', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'Which actor runs Task_1?' }] } };
    expect(messageToText(msg)).toBe('Which actor runs Task_1?');
  });
  it('summarizes a tool use as an op proposal', () => {
    const msg = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__flowfabric__propose_patch_ops', input: { ops: [{ op: 'setTaskType' }] } }] } };
    expect(messageToText(msg)).toContain('proposed 1 patch op');
  });
  it('returns null for result/system frames', () => {
    expect(messageToText({ type: 'result', session_id: 'x' })).toBeNull();
  });
});
