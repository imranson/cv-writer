import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatService, isUserVisible, SessionBusyError, SessionNotFoundError, type ChatEvent } from '../../src/chat/service.js';
import { Workspace } from '../../src/storage/workspace.js';
import { makeRuntime, tempDir } from '../support/fixtures.js';
import { journeyLlm } from '../support/journey.js';
import { say, ScriptedLLM } from '../support/scriptedLlm.js';

let dir: string;
let cleanup: () => Promise<void>;
let ws: Workspace;
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  ws = new Workspace(dir);
});
afterEach(() => cleanup());

describe('ChatService', () => {
  it('creates, lists, reads and deletes independent sessions', async () => {
    const chat = new ChatService(makeRuntime(new ScriptedLLM({}), ws), ws);
    const a = await chat.create();
    const b = await chat.create();
    expect(a.id).toMatch(/^chat-/);
    expect((await chat.list()).map((s) => s.id).sort()).toEqual([a.id, b.id].sort());
    expect(await chat.get(a.id)).toMatchObject({ title: 'New chat', messages: [] });
    expect(await chat.delete(a.id)).toBe(true);
    expect(await chat.get(a.id)).toBeUndefined();
    expect(await ws.sessions.list()).toEqual([b.id]);
  });

  it('runs a turn through the coordinator, persists history, title and context usage', async () => {
    const chat = new ChatService(makeRuntime(journeyLlm(), ws), ws);
    const session = await chat.create();
    const events: ChatEvent[] = [];
    await chat.send(session.id, 'Hi, I am Ada Lovelace.\nMore details', (e) => events.push(e));

    const saved = (await chat.get(session.id))!;
    expect(saved.title).toBe('Hi, I am Ada Lovelace.');
    expect(saved.messages[0]).toEqual({ role: 'user', content: 'Hi, I am Ada Lovelace.\nMore details' });
    expect(saved.messages.at(-1)!.content).toContain('ready in the preview panel');
    expect(saved.usage).toMatchObject({ contextWindow: 262_144 });
    expect(saved.usage!.usedTokens).toBeGreaterThan(0);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect(chat.isRunning(session.id)).toBe(false);
  });

  it('only forwards coordinator text to the user; subagent work shows as activity', async () => {
    const chat = new ChatService(makeRuntime(journeyLlm(), ws), ws);
    const session = await chat.create();
    const events: ChatEvent[] = [];
    await chat.send(session.id, 'go', (e) => events.push(e));
    const textEvents = events.filter((e) => e.type === 'delta' || e.type === 'message') as { depth: number; agent: string }[];
    expect(textEvents.length).toBeGreaterThan(0);
    expect(textEvents.every((e) => e.depth === 0 && e.agent === 'coordinator')).toBe(true);
    const userText = events.map((e) => (e.type === 'delta' ? e.content : '')).join('');
    expect(userText).not.toContain('WRITER REPORT');
    expect(userText).not.toContain('CRITIC');
    expect(events.some((e) => e.type === 'tool_call' && e.agent === 'writer')).toBe(true);
    expect(events.some((e) => e.type === 'tool_call' && e.agent === 'critic')).toBe(true);
    expect(isUserVisible({ type: 'delta', agent: 'writer', depth: 1, content: 'x' })).toBe(false);
    expect(isUserVisible({ type: 'data_changed', kind: 'cv', id: 'x' })).toBe(true);
  });

  it('saves all reasoning in the session but drops earlier turns’ reasoning from the model’s history', async () => {
    const llm = new ScriptedLLM({ coordinator: () => ({ ...say('ok'), thinking: 'secret reasoning' }) });
    const chat = new ChatService(makeRuntime(llm, ws), ws);
    const s = await chat.create();
    await chat.send(s.id, 'one', () => {});
    await chat.send(s.id, 'two', () => {});
    expect(JSON.stringify(llm.requests[1].messages)).not.toContain('secret reasoning');
    const saved = (await chat.get(s.id))!.messages;
    expect(saved.map((m) => m.thinking)).toEqual([undefined, 'secret reasoning', undefined, 'secret reasoning']);
  });

  it('rejects concurrent turns and unknown sessions', async () => {
    const llm = new ScriptedLLM({ coordinator: () => say('slow') });
    llm.delayMs = 100;
    const chat = new ChatService(makeRuntime(llm, ws), ws);
    const s = await chat.create();
    const first = chat.send(s.id, 'one', () => {});
    await expect(chat.send(s.id, 'two', () => {})).rejects.toBeInstanceOf(SessionBusyError);
    await first;
    await expect(chat.send('chat-nope', 'x', () => {})).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(chat.send('../bad', 'x', () => {})).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('can be stopped, and reports model errors as events', async () => {
    const llm = new ScriptedLLM({ coordinator: () => say('never') });
    llm.delayMs = 5_000;
    const chat = new ChatService(makeRuntime(llm, ws), ws);
    const s = await chat.create();
    const events: ChatEvent[] = [];
    const run = chat.send(s.id, 'one', (e) => events.push(e));
    await new Promise((r) => setTimeout(r, 20));
    expect(chat.stop(s.id)).toBe(true);
    await run;
    expect(events.at(-1)).toEqual({ type: 'stopped' });
    expect((await chat.get(s.id))!.messages).toEqual([{ role: 'user', content: 'one' }]);

    const failing = new ChatService(makeRuntime(new ScriptedLLM({ coordinator: () => { throw new Error('connection refused'); } }), ws), ws);
    const s2 = await failing.create();
    const errors: ChatEvent[] = [];
    await failing.send(s2.id, 'hi', (e) => errors.push(e));
    expect(errors.at(-1)).toEqual({ type: 'error', message: 'connection refused' });
  });
});
