import type { ChatMessage, ToolSchema } from '../llm/types.js';
import type { AgentName } from '../config.js';

/** Rough token estimate (~4 characters per token) plus per-message overhead. */
export function estimateTokens(messages: ChatMessage[], tools: ToolSchema[] = []): number {
  let chars = 0;
  for (const m of messages) {
    chars += (m.content?.length ?? 0) + (m.thinking?.length ?? 0) + 16;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (tools.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4);
}

export function formatTokens(n: number): string {
  return n.toLocaleString('en-US');
}

export interface SystemInfoInput {
  agent: AgentName;
  now: Date;
  timezone?: string;
  usedTokens: number;
  contextWindow: number;
  estimated: boolean;
}

function safeTimezone(tz?: string): string {
  if (!tz) return 'UTC';
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return tz;
  } catch {
    return 'UTC';
  }
}

/** System information every agent can see: current date/time and a context window indicator. */
export function systemInfoBlock(info: SystemInfoInput): string {
  const timeZone = safeTimezone(info.timezone);
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(info.now);
  const pct = info.contextWindow > 0 ? (info.usedTokens / info.contextWindow) * 100 : 0;
  const level = pct >= 85 ? 'critical — be concise and avoid re-reading large documents' : pct >= 60 ? 'high' : 'ok';
  return [
    '<system_info>',
    `agent: ${info.agent}`,
    `datetime: ${info.now.toISOString()} (${human}, ${timeZone})`,
    `context_window: ${formatTokens(info.usedTokens)} / ${formatTokens(info.contextWindow)} tokens used (${pct.toFixed(1)}%${info.estimated ? ', estimated' : ''}) — ${level}`,
    '</system_info>',
  ].join('\n');
}

export const MAX_TOOL_RESULT_CHARS = 24_000;

export function clipToolResult(text: string, max = MAX_TOOL_RESULT_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n…[truncated ${text.length - max} characters to protect the context window]`;
}

const TRIMMED = '[older tool result removed to free context; call the tool again if you need it]';

/**
 * Frees context by blanking the oldest tool results (keeping the most recent
 * `keepRecent` messages intact) until the estimate falls below `targetTokens`.
 * Returns a new array; the input is not mutated.
 */
export function compactMessages(
  messages: ChatMessage[],
  opts: { targetTokens: number; fixedTokens?: number; keepRecent?: number },
): { messages: ChatMessage[]; trimmed: number } {
  const keepRecent = opts.keepRecent ?? 6;
  const out = messages.map((m) => ({ ...m }));
  let total = estimateTokens(out) + (opts.fixedTokens ?? 0);
  let trimmed = 0;
  for (let i = 0; i < out.length - keepRecent && total > opts.targetTokens; i++) {
    const m = out[i];
    if (m.role === 'tool' && m.content !== TRIMMED && m.content.length > TRIMMED.length) {
      total -= Math.ceil((m.content.length - TRIMMED.length) / 4);
      m.content = TRIMMED;
      trimmed++;
    } else if (m.role === 'assistant' && m.thinking) {
      total -= Math.ceil(m.thinking.length / 4);
      delete m.thinking;
    }
  }
  return { messages: out, trimmed };
}
