import type { Message } from 'ollama';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService, NotFoundError, SessionBusyError, repairToolPairs, titleFrom } from '../../src/chat';
import { ScriptedLLM, makeDeps, tempDir } from '../helpers';

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => (tmp = await tempDir()));
afterEach(() => tmp.cleanup());

describe('repairToolPairs', () => {
  it('adds placeholder results for unanswered tool calls', () => {
    const msgs: Message[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { function: { name: 'a', arguments: {} } },
          { function: { name: 'b', arguments: {} } },
        ],
      },
      { role: 'tool', content: 'A', tool_name: 'a' },
    ];
    const out = repairToolPairs(msgs);
    expect(out).toHaveLength(4);
    expect(out[3]).toMatchObject({ role: 'tool', tool_name: 'b', content: expect.stringMatching(/interrupted/) });
    expect(repairToolPairs(out)).toEqual(out);
  });
});

describe('titleFrom', () => {
  it('uses the first message, shortened', () => {
    expect(titleFrom('  Help me\nwith my CV ')).toBe('Help me with my CV');
    expect(titleFrom('x'.repeat(100))).toHaveLength(58);
    expect(titleFrom('   ')).toBe('New conversation');
  });
});

describe('ChatService', () => {
  it('runs a coordinator turn and persists history, events, usage and title', async () => {
    const llm = new ScriptedLLM({ coordinator: [{ tools: [['readProfile', {}]] }, { content: 'Hello! Tell me about your work.' }] });
    const deps = makeDeps(tmp.dir, llm);
    const session = await deps.store.createSession('u1');
    const streamed: string[] = [];
    const { text } = await new ChatService(deps).sendMessage({ userId: 'u1', sessionId: session.id, content: 'Hi there', emit: (e) => streamed.push(e.type) });

    expect(text).toBe('Hello! Tell me about your work.');
    expect(streamed).toContain('delta');
    const saved = (await deps.store.getSession('u1', session.id))!;
    expect(saved.title).toBe('Hi there');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(saved.events[0]).toMatchObject({ type: 'user_message', content: 'Hi there' });
    expect(saved.events.some((e) => (e as any).type === 'delta')).toBe(false);
    expect(saved.events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
    expect(saved.usage.coordinator?.window).toBe(100_000);
  });

  it('continues an existing conversation with full history', async () => {
    const llm = new ScriptedLLM();
    const deps = makeDeps(tmp.dir, llm);
    const session = await deps.store.createSession('u1');
    const chat = new ChatService(deps);
    await chat.sendMessage({ userId: 'u1', sessionId: session.id, content: 'one', emit: () => {} });
    await chat.sendMessage({ userId: 'u1', sessionId: session.id, content: 'two', emit: () => {} });
    const sent = llm.requests[1].request.messages.slice(1).map((m) => m.content);
    expect(sent).toEqual(['one', 'coordinator done', 'two']);
  });

  it('rejects concurrent turns on the same session', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLLM();
    const orig = llm.chat.bind(llm);
    llm.chat = async (req) => (await gate, orig(req));
    const deps = makeDeps(tmp.dir, llm);
    const session = await deps.store.createSession('u1');
    const chat = new ChatService(deps);
    const first = chat.sendMessage({ userId: 'u1', sessionId: session.id, content: 'a', emit: () => {} });
    expect(chat.isRunning('u1', session.id)).toBe(true);
    await expect(chat.sendMessage({ userId: 'u1', sessionId: session.id, content: 'b', emit: () => {} })).rejects.toBeInstanceOf(SessionBusyError);
    release();
    await first;
    expect(chat.isRunning('u1', session.id)).toBe(false);
  });

  it('persists an interrupted turn with a valid history', async () => {
    const llm = new ScriptedLLM({ coordinator: [{ tools: [['readProfile', {}]] }] });
    const orig = llm.chat.bind(llm);
    let calls = 0;
    llm.chat = async (req) => {
      if (++calls === 2) throw new Error('model unavailable');
      return orig(req);
    };
    const deps = makeDeps(tmp.dir, llm);
    const session = await deps.store.createSession('u1');
    await expect(new ChatService(deps).sendMessage({ userId: 'u1', sessionId: session.id, content: 'hi', emit: () => {} })).rejects.toThrow(
      'model unavailable',
    );
    const saved = (await deps.store.getSession('u1', session.id))!;
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(saved.messages.at(-1)!.content).toMatch(/interrupted: model unavailable/);
    expect(saved.events.at(-1)).toMatchObject({ type: 'error', message: 'model unavailable' });
  });

  it('throws NotFoundError for unknown sessions', async () => {
    const chat = new ChatService(makeDeps(tmp.dir));
    await expect(chat.sendMessage({ userId: 'u1', sessionId: 'missing', content: 'x', emit: () => {} })).rejects.toBeInstanceOf(NotFoundError);
  });
});
