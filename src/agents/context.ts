import type { ChatMessage, Usage } from '../llm/types.js';

export const DEFAULT_CONTEXT_WINDOW = 32_768;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageText(m: ChatMessage): string {
  return m.content + (m.thinking ?? '') + (m.tool_calls ? JSON.stringify(m.tool_calls) : '');
}

/**
 * Tracks context usage: exact token counts reported by the model for everything up to the
 * last response, plus an estimate for messages added since (tool results, new user input).
 */
export class ContextMeter {
  private reportedTokens = 0;
  private reportedCount = 0;

  constructor(readonly window: number) {}

  used(systemPrompt: string, messages: ChatMessage[]): number {
    if (this.reportedCount === 0 || this.reportedCount > messages.length) {
      return estimateTokens(systemPrompt) + messages.reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
    }
    return this.reportedTokens + messages.slice(this.reportedCount).reduce((sum, m) => sum + estimateTokens(messageText(m)), 0);
  }

  /** Call after appending the model's response; `messageCount` includes that response. */
  record(usage: Usage | undefined, messageCount: number): void {
    if (!usage || usage.promptTokens <= 0) return;
    this.reportedTokens = usage.promptTokens + usage.completionTokens;
    this.reportedCount = messageCount;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO 8601 with the local UTC offset of `timeZone`, e.g. 2026-10-11T15:42:00+01:00. */
export function isoWithOffset(date: Date, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const local = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offsetMinutes = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export interface SystemInfo {
  now: Date;
  timeZone: string;
  usedTokens: number;
  contextWindow: number;
}

export function formatSystemInfo(info: SystemInfo): string {
  const human = new Intl.DateTimeFormat('en-GB', {
    timeZone: info.timeZone,
    dateStyle: 'full',
    timeStyle: 'short',
  }).format(info.now);
  const pct = (info.usedTokens / info.contextWindow) * 100;
  const remaining = Math.max(0, info.contextWindow - info.usedTokens);
  const fmt = (n: number) => n.toLocaleString('en-US');
  const lines = [
    '## System information',
    `- Current date and time: ${human} (${info.timeZone}); ISO ${isoWithOffset(info.now, info.timeZone)}`,
    `- Context window: ${fmt(info.usedTokens)} / ${fmt(info.contextWindow)} tokens used (${pct.toFixed(1)}%), ${fmt(remaining)} remaining`,
  ];
  if (pct >= 75) lines.push('- Context is running low: be brief, avoid fetching large pages, and summarise instead of quoting.');
  return lines.join('\n');
}
