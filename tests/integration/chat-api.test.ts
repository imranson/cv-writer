import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/shared/events.js';
import { call, createTestApp, parseSse, register, say, ScriptedLlm, TestClient } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let llm: ScriptedLlm;
let ada: TestClient;
let bob: TestClient;

beforeAll(async () => {
  llm = new ScriptedLlm();
  ctx = await createTestApp({ llm });
  ada = new TestClient(ctx.app);
  bob = new TestClient(ctx.app);
  await register(ada, 'ada@example.com', 'Ada');
  await register(bob, 'bob@example.com', 'Bob');
});
afterAll(async () => {
  await ctx.chat.drain();
  await ctx.db.close();
});

async function send(client: TestClient, chatId: string, text: string, extra: Record<string, unknown> = {}) {
  const res = await client.request('POST', `/api/chats/${chatId}/messages`, { text, ...extra });
  expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
  return parseSse(await res.text());
}

describe('chat turns over SSE', () => {
  it('streams the whole turn and persists transcript, turns and activity', async () => {
    const { body } = await ada.json('POST', '/api/chats', {});
    const chatId = body.chat.id;
    const job = (await ada.json('POST', '/api/jobs', { job: { title: 'Engineer', company: 'Acme' } })).body.job;
    llm.push(
      'coordinator',
      { ...call('editProfile', { patch: { summary: 'Mathematician' } }), thinking: 'Save that.' },
      say('Saved your summary. Shall I draft the CV?'),
    );
    const events = await send(ada, chatId, 'I am a mathematician', { focusJobId: job.id, timeZone: 'Europe/London' });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn_start');
    expect(types).toContain('chat_title');
    expect(types).toContain('agent_start');
    expect(types).toContain('thinking');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('data_changed');
    expect(types.at(-1)).toBe('turn_end');
    const end = events.at(-1) as Extract<AgentEvent, { type: 'turn_end' }>;
    expect(end).toMatchObject({ status: 'done', answer: 'Saved your summary. Shall I draft the CV?' });

    // The coordinator saw the selected job and user in its system information.
    const sys = llm.requests.at(-1)!.req.messages[0].content;
    expect(sys).toContain(`Job selected in the UI: ${job.id} — Engineer at Acme`);
    expect(sys).toContain('Signed-in user: Ada <ada@example.com>');
    expect(sys).toContain('time zone Europe/London');

    const saved = await ada.json('GET', `/api/chats/${chatId}`);
    expect(saved.body.chat.title).toBe('I am a mathematician');
    expect(saved.body.chat.focusJobId).toBe(job.id);
    expect(saved.body.chat.turns).toHaveLength(1);
    const turn = saved.body.chat.turns[0];
    expect(turn).toMatchObject({ user: 'I am a mathematician', answer: 'Saved your summary. Shall I draft the CV?', status: 'done' });
    const root = turn.activity.runs[turn.activity.rootRunIds[0]];
    expect(root.steps[0].thinking).toBe('Save that.');
    expect(root.steps[1]).toMatchObject({ kind: 'tool', name: 'editProfile', ok: true });
    expect(saved.body.context.transcriptTokens).toBeGreaterThan(0);
    expect((await ada.json('GET', '/api/profile')).body.profile.summary).toBe('Mathematician');
  });

  it('keeps conversation history across turns', async () => {
    const chatId = (await ada.json('POST', '/api/chats', {})).body.chat.id;
    llm.push('coordinator', say('Nice to meet you.'), say('You said hello earlier.'));
    await send(ada, chatId, 'hello');
    await send(ada, chatId, 'what did I say?');
    const msgs = llm.requests.at(-1)!.req.messages.slice(1).map((m) => `${m.role}:${m.content}`);
    expect(msgs).toEqual(['user:hello', 'assistant:Nice to meet you.', 'user:what did I say?']);
    expect((await ada.json('GET', `/api/chats/${chatId}`)).body.chat.turns).toHaveLength(2);
  });

  it('rejects empty messages, foreign chats and concurrent turns', async () => {
    const chatId = (await ada.json('POST', '/api/chats', {})).body.chat.id;
    expect((await ada.json('POST', `/api/chats/${chatId}/messages`, { text: '  ' })).status).toBe(400);
    expect((await bob.json('POST', `/api/chats/${chatId}/messages`, { text: 'hi' })).status).toBe(404);

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    llm.push('coordinator', async () => {
      await gate;
      return say('done');
    });
    const first = ada.request('POST', `/api/chats/${chatId}/messages`, { text: 'slow' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await ada.json('POST', `/api/chats/${chatId}/messages`, { text: 'again' })).status).toBe(409);

    // While running: chat GET exposes the live turn and the stream can be re-attached.
    const live = await ada.json('GET', `/api/chats/${chatId}`);
    expect(live.body.live).toMatchObject({ userText: 'slow' });
    expect((await bob.json('GET', `/api/chats/${chatId}/stream`)).status).toBe(404);
    const reattach = ada.request('GET', `/api/chats/${chatId}/stream`);
    await new Promise((r) => setTimeout(r, 30)); // let the re-attach subscribe before the turn finishes
    release();
    const [a, b] = await Promise.all([first, reattach]);
    const ea = parseSse(await a.text());
    const eb = parseSse(await b.text());
    expect(ea.at(-1)).toMatchObject({ type: 'turn_end', answer: 'done' });
    expect(eb[0].type).toBe('turn_start'); // replayed from the start
    expect(eb.at(-1)).toMatchObject({ type: 'turn_end', answer: 'done' });
    expect((await ada.json('GET', `/api/chats/${chatId}/stream`)).status).toBe(404);
  });

  it('stop aborts the turn and records it as aborted', async () => {
    const chatId = (await ada.json('POST', '/api/chats', {})).body.chat.id;
    llm.push('coordinator', async (req) => {
      await new Promise<void>((resolve) => req.signal!.addEventListener('abort', () => resolve()));
      throw new Error('aborted');
    });
    const pending = ada.request('POST', `/api/chats/${chatId}/messages`, { text: 'long task' });
    await new Promise((r) => setTimeout(r, 30));
    expect((await bob.json('POST', `/api/chats/${chatId}/stop`, {})).body).toEqual({ stopped: false });
    expect((await ada.json('POST', `/api/chats/${chatId}/stop`, {})).body).toEqual({ stopped: true });
    const events = parseSse(await (await pending).text());
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'aborted' });
    const saved = await ada.json('GET', `/api/chats/${chatId}`);
    expect(saved.body.chat.turns[0].status).toBe('aborted');
    expect(saved.body.chat.turns[0].activity.runs[saved.body.chat.turns[0].activity.rootRunIds[0]].status).toBe('aborted');
    // The transcript stays consistent for the next turn.
    llm.push('coordinator', say('Back again.'));
    const next = await send(ada, chatId, 'continue');
    expect(next.at(-1)).toMatchObject({ status: 'done', answer: 'Back again.' });
  });

  it('LLM failures end the turn with an error answer instead of hanging', async () => {
    const chatId = (await ada.json('POST', '/api/chats', {})).body.chat.id;
    llm.push('coordinator', async () => {
      throw new Error('Ollama 503: overloaded');
    });
    const events = await send(ada, chatId, 'hi');
    expect(events.at(-1)).toMatchObject({ type: 'turn_end', status: 'error' });
    expect((events.at(-1) as any).answer).toMatch(/overloaded/);
  });

  it('a turn keeps running and is saved even if the client disconnects', async () => {
    const chatId = (await ada.json('POST', '/api/chats', {})).body.chat.id;
    llm.push('coordinator', async () => {
      await new Promise((r) => setTimeout(r, 50));
      return say('finished in background');
    });
    const res = await ada.request('POST', `/api/chats/${chatId}/messages`, { text: 'bg' });
    await res.body!.cancel(); // simulate the browser going away
    await ctx.chat.drain();
    const saved = await ada.json('GET', `/api/chats/${chatId}`);
    expect(saved.body.chat.turns[0]).toMatchObject({ answer: 'finished in background', status: 'done' });
  });
});
