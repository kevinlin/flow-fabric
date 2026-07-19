/* eslint-disable @typescript-eslint/no-explicit-any */
/** Turn a Claude Agent SDK stream message into a line for the grill chat, or null to skip. */
export function messageToText(msg: any): string | null {
  if (msg?.type !== 'assistant') return null;
  const blocks = msg.message?.content ?? [];
  const parts: string[] = [];
  for (const b of blocks) {
    if (b.type === 'text' && b.text?.trim()) parts.push(b.text.trim());
    else if (b.type === 'tool_use' && b.name?.includes('propose_patch_ops')) {
      const n = Array.isArray(b.input?.ops) ? b.input.ops.length : 0;
      parts.push(`(proposed ${n} patch op${n === 1 ? '' : 's'})`);
    }
  }
  return parts.length ? parts.join('\n') : null;
}
