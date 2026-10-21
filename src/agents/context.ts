import type { Message, Tool } from 'ollama';

/** Rough token estimate (~4 characters per token) used before the model reports real counts. */
export function estimateTokens(messages: Message[], system = '', tools: Tool[] = []): number {
  let chars = system.length + JSON.stringify(tools).length;
  for (const m of messages) {
    chars += m.content.length + (m.thinking?.length ?? 0) + 8;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

export const COMPACTED_TOOL_RESULT = '[Older tool result removed to free context. Call the tool again if you still need it.]';

/**
 * Shrinks history to fit `budget` tokens: first blanks old tool results, then drops the
 * oldest turns (always restarting at a user message so tool calls stay paired).
 * The last `keepRecent` messages are never touched.
 */
export function compactMessages(messages: Message[], budget: number, extraTokens = 0, keepRecent = 8): Message[] {
  let out = messages.map((m) => ({ ...m }));
  const fits = () => estimateTokens(out) + extraTokens <= budget;
  if (fits()) return out;

  for (let i = 0; i < out.length - keepRecent && !fits(); i++) {
    if (out[i].role === 'tool' && out[i].content !== COMPACTED_TOOL_RESULT) out[i].content = COMPACTED_TOOL_RESULT;
  }
  while (!fits() && out.length > keepRecent) {
    const nextUser = out.findIndex((m, i) => i > 0 && m.role === 'user');
    if (nextUser === -1 || nextUser > out.length - keepRecent) break;
    out = out.slice(nextUser);
  }
  return out;
}

export function formatUsage(used: number, window: number): string {
  const pct = window > 0 ? ((used / window) * 100).toFixed(1) : '0.0';
  return `${used.toLocaleString('en-US')} of ${window.toLocaleString('en-US')} tokens used (${pct}%)`;
}
