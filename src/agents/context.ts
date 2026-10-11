import type { ChatMessage, ChatModel } from '../llm/types.ts';
import type { Session, StoredMessage } from '../storage/store.ts';
import { truncate } from '../util/text.ts';
import { COMPACTION_PROMPT } from './prompts.ts';

/** Messages that are still part of the model's context (after any compaction). */
export function contextMessages(session: Session): ChatMessage[] {
  return repairToolPairs(session.messages.slice(session.contextStart).map(toChatMessage));
}

/**
 * A turn interrupted mid-tool-call leaves an assistant tool request without results, which models
 * reject or misread. Insert placeholder results so every tool call is answered.
 */
export function repairToolPairs(messages: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    out.push(m);
    const calls = m.role === 'assistant' ? (m.toolCalls ?? []) : [];
    if (!calls.length) continue;
    let answered = 0;
    while (messages[i + 1]?.role === 'tool' && answered < calls.length) {
      out.push(messages[++i]!);
      answered++;
    }
    for (const call of calls.slice(answered)) {
      out.push({ role: 'tool', toolName: call.name, content: 'Error: interrupted by the user before this tool finished.' });
    }
  }
  return out;
}

export function toChatMessage({ id: _id, at: _at, ...m }: StoredMessage): ChatMessage {
  return m;
}

/** Rough token estimate (~4 characters per token) used before the model reports real usage. */
export function estimateContextTokens(system: string, messages: ChatMessage[]): number {
  let chars = system.length;
  for (const m of messages) {
    chars += m.content.length + (m.thinking?.length ?? 0) + 16;
    for (const c of m.toolCalls ?? []) chars += c.name.length + JSON.stringify(c.arguments).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Where compaction can cut: the start of a user message at least `keepRecent` messages
 * from the end, so tool calls stay paired with their results. Returns -1 if there is nothing to compact.
 */
export function findCompactionCut(session: Session, keepRecent = 6): number {
  const limit = session.messages.length - keepRecent;
  for (let i = limit; i > session.contextStart; i--) {
    if (session.messages[i]?.role === 'user') return i;
  }
  return -1;
}

export function renderTranscript(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      if (m.role === 'user') return `USER: ${m.content}`;
      if (m.role === 'tool') return `TOOL RESULT (${m.toolName}): ${truncate(m.content, 600)}`;
      const calls = m.toolCalls?.map((c) => `[called ${c.name}(${truncate(JSON.stringify(c.arguments), 300)})]`).join(' ') ?? '';
      return `COACH: ${[m.content.trim(), calls].filter(Boolean).join(' ')}`;
    })
    .join('\n\n');
}

/** Summarises older messages into `session.summary` and moves `contextStart` forward. */
export async function compactSession(session: Session, model: ChatModel, opts: { keepRecent?: number; signal?: AbortSignal } = {}): Promise<{ session: Session; compacted: number }> {
  const cut = findCompactionCut(session, opts.keepRecent ?? 6);
  if (cut < 0) return { session, compacted: 0 };
  const older = session.messages.slice(session.contextStart, cut).map(toChatMessage);
  const previous = session.summary.trim() ? `Summary of even earlier conversation:\n${session.summary.trim()}\n\n` : '';
  const result = await model.chat({
    messages: [
      { role: 'system', content: COMPACTION_PROMPT },
      { role: 'user', content: `${previous}Conversation to summarise:\n\n${renderTranscript(older)}` },
    ],
    signal: opts.signal,
  });
  const summary = result.message.content.trim();
  if (!summary) return { session, compacted: 0 };
  return { session: { ...session, summary, contextStart: cut }, compacted: cut - session.contextStart };
}
