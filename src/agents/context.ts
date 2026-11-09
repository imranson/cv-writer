import type { ChatMessage, ToolSpec } from '../llm/types.js';
import type { ContextInfo } from '../shared/events.js';

/** Rough token estimate: ~4 characters per token plus a small per-message overhead. */
export function estimateTokens(messages: ChatMessage[], tools: ToolSpec[] = []): number {
  let chars = 0;
  for (const m of messages) {
    chars += m.content.length + 16;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  if (tools.length) chars += JSON.stringify(tools).length;
  return Math.ceil(chars / 4);
}

export function contextInfo(estimatedTokens: number, window: number, promptTokens?: number): ContextInfo {
  return {
    estimatedTokens,
    window,
    percent: window > 0 ? Math.round((estimatedTokens / window) * 1000) / 10 : 0,
    ...(promptTokens !== undefined ? { promptTokens } : {}),
  };
}

export function formatDateTime(now: Date, timeZone?: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: zone });
  } catch {
    zone = undefined;
  }
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).format(now);
  return `${human} (ISO ${now.toISOString()}${zone ? `, time zone ${zone}` : ''})`;
}

export function systemInfoBlock(opts: {
  now: Date;
  timeZone?: string;
  context: ContextInfo;
  lastPromptTokens?: number;
  extra?: string[];
}): string {
  const c = opts.context;
  const lines = [
    '# System information',
    `- Current date and time: ${formatDateTime(opts.now, opts.timeZone)}`,
    `- Context window: ~${c.estimatedTokens.toLocaleString('en-US')} of ${c.window.toLocaleString('en-US')} tokens used (${c.percent}%, estimated)` +
      (opts.lastPromptTokens ? `; last model-reported prompt size: ${opts.lastPromptTokens.toLocaleString('en-US')} tokens` : ''),
  ];
  if (c.percent >= 75) lines.push('- Context is getting full: be concise, avoid re-reading large documents unnecessarily.');
  if (opts.extra) lines.push(...opts.extra.map((l) => `- ${l}`));
  return lines.join('\n');
}

const TRUNCATED_NOTE = '…[older tool output truncated to save context — call the tool again if needed]';

/**
 * Keeps the transcript inside the context window: once the estimate passes `threshold` of the window,
 * older tool outputs (all but the most recent `keepRecent`) are truncated. Returns a new array.
 */
export function compactMessages(
  messages: ChatMessage[],
  window: number,
  opts: { threshold?: number; keepRecent?: number; keepChars?: number; reserveTokens?: number } = {},
): { messages: ChatMessage[]; compacted: number } {
  const threshold = opts.threshold ?? 0.7;
  const keepRecent = opts.keepRecent ?? 4;
  const keepChars = opts.keepChars ?? 600;
  const budget = window * threshold - (opts.reserveTokens ?? 0);
  if (estimateTokens(messages) <= budget) return { messages, compacted: 0 };
  const toolIdx = messages.map((m, i) => (m.role === 'tool' ? i : -1)).filter((i) => i >= 0);
  const candidates = toolIdx.slice(0, Math.max(0, toolIdx.length - keepRecent));
  const out = messages.slice();
  let compacted = 0;
  for (const i of candidates) {
    if (out[i].content.length <= keepChars + TRUNCATED_NOTE.length) continue;
    out[i] = { ...out[i], content: out[i].content.slice(0, keepChars) + TRUNCATED_NOTE };
    compacted++;
    if (estimateTokens(out) <= budget) break;
  }
  return { messages: out, compacted };
}
