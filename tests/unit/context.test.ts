import { describe, expect, it } from 'vitest';
import { compactSession, contextMessages, estimateContextTokens, findCompactionCut, renderTranscript, repairToolPairs } from '../../src/agents/context.ts';
import type { ChatMessage } from '../../src/llm/types.ts';
import type { Session, StoredMessage } from '../../src/storage/store.ts';
import { say, ScriptedModel } from '../support/scriptedModel.ts';

const msg = (m: ChatMessage, i: number): StoredMessage => ({ ...m, id: String(i), at: '' });
function session(messages: ChatMessage[], extra: Partial<Session> = {}): Session {
  return { id: 's', title: 't', jobId: null, createdAt: '', updatedAt: '', messages: messages.map(msg), contextStart: 0, summary: '', context: { tokens: 0, limit: 1000, estimated: true }, ...extra };
}

const convo: ChatMessage[] = [
  { role: 'user', content: 'u1' },
  { role: 'assistant', content: '', toolCalls: [{ name: 'read_profile', arguments: {} }] },
  { role: 'tool', toolName: 'read_profile', content: 'profile' },
  { role: 'assistant', content: 'a1' },
  { role: 'user', content: 'u2' },
  { role: 'assistant', content: 'a2' },
  { role: 'user', content: 'u3' },
  { role: 'assistant', content: 'a3' },
];

describe('context helpers', () => {
  it('finds a compaction cut at a user message, keeping recent messages', () => {
    expect(findCompactionCut(session(convo), 2)).toBe(6);
    expect(findCompactionCut(session(convo), 4)).toBe(4);
    expect(findCompactionCut(session(convo), 8)).toBe(-1);
    expect(findCompactionCut(session(convo, { contextStart: 6 }), 2)).toBe(-1);
  });

  it('answers dangling tool calls left by an interrupted turn', () => {
    const repaired = repairToolPairs([
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ name: 'a', arguments: {} }, { name: 'b', arguments: {} }] },
      { role: 'tool', toolName: 'a', content: 'ok' },
      { role: 'user', content: 'next' },
    ]);
    expect(repaired.map((m) => `${m.role}:${m.toolName ?? ''}`)).toEqual(['user:', 'assistant:', 'tool:a', 'tool:b', 'user:']);
    expect(repaired[3]!.content).toMatch(/interrupted/);
    expect(repairToolPairs(convo)).toEqual(convo);
  });

  it('only sends messages after contextStart, without storage fields', () => {
    const msgs = contextMessages(session(convo, { contextStart: 4 }));
    expect(msgs.map((m) => m.content)).toEqual(['u2', 'a2', 'u3', 'a3']);
    expect(msgs[0]).not.toHaveProperty('id');
  });

  it('estimates tokens from characters', () => {
    expect(estimateContextTokens('x'.repeat(400), [])).toBe(100);
    expect(estimateContextTokens('', [{ role: 'user', content: 'x'.repeat(84) }])).toBe(25);
  });

  it('renders a readable transcript for summarisation', () => {
    const t = renderTranscript(convo.slice(0, 4));
    expect(t).toContain('USER: u1');
    expect(t).toContain('COACH: [called read_profile({})]');
    expect(t).toContain('TOOL RESULT (read_profile): profile');
  });
});

describe('compactSession', () => {
  it('summarises older messages and moves the context start', async () => {
    const model = new ScriptedModel([say('- Summary of u1/u2')]);
    const { session: next, compacted } = await compactSession(session(convo, { summary: 'very old' }), model, { keepRecent: 2 });
    expect(compacted).toBe(6);
    expect(next.contextStart).toBe(6);
    expect(next.summary).toBe('- Summary of u1/u2');
    const prompt = model.requests[0]!.messages[1]!.content;
    expect(prompt).toContain('very old');
    expect(prompt).toContain('USER: u2');
    expect(prompt).not.toContain('u3');
    expect(model.requests[0]!.tools).toBeUndefined();
  });

  it('does nothing when there is too little history or the summary is empty', async () => {
    const model = new ScriptedModel([say('')]);
    expect((await compactSession(session(convo.slice(0, 2)), model)).compacted).toBe(0);
    expect((await compactSession(session(convo), model, { keepRecent: 2 })).compacted).toBe(0);
  });
});
