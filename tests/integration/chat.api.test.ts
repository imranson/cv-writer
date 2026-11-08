import { afterEach, describe, expect, it } from 'vitest';
import { createTestEnv, readSse, TestClient, type TestEnv } from '../helpers/env.js';
import { call, reply, ScriptedLlm } from '../helpers/scriptedLlm.js';

let env: TestEnv | undefined;
afterEach(async () => {
  await env?.close();
  env = undefined;
});

async function setup(llm: ScriptedLlm) {
  env = await createTestEnv({ llm });
  const client = new TestClient(env.app);
  await client.register();
  const { body } = await client.json('POST', '/api/sessions', {});
  return { client, sessionId: body.session.id as string };
}

describe('chat sessions API', () => {
  it('creates, lists, renames and deletes sessions', async () => {
    const { client, sessionId } = await setup(new ScriptedLlm());
    expect((await client.json('GET', '/api/sessions')).body.sessions).toMatchObject([{ id: sessionId, title: 'New chat' }]);
    expect((await client.json('PATCH', `/api/sessions/${sessionId}`, { title: 'Applications 2026' })).body).toEqual({ ok: true });
    expect((await client.json('GET', `/api/sessions/${sessionId}`)).body.session).toMatchObject({ title: 'Applications 2026', messages: [], activity: [], busy: false });
    expect((await client.json('DELETE', `/api/sessions/${sessionId}`)).body).toEqual({ ok: true });
    expect((await client.json('GET', `/api/sessions/${sessionId}`)).status).toBe(404);
  });

  it('keeps sessions private to their owner', async () => {
    const { sessionId } = await setup(new ScriptedLlm());
    const intruder = new TestClient(env!.app);
    await intruder.register('intruder@example.com');
    expect((await intruder.json('GET', `/api/sessions/${sessionId}`)).status).toBe(404);
    expect((await intruder.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'hi' })).status).toBe(404);
    expect((await intruder.json('DELETE', `/api/sessions/${sessionId}`)).status).toBe(404);
  });
});

describe('streaming a coordinator turn over SSE', () => {
  it('streams every agent event and persists transcript + activity', async () => {
    const llm = new ScriptedLlm({
      coordinator: [call('editProfile', { operations: [{ op: 'set', path: 'headline', value: 'Engineer' }] }), reply('Saved your headline. **What roles** are you targeting?')],
    });
    const { client, sessionId } = await setup(llm);
    const res = await client.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'I am an engineer', timezone: 'Europe/Paris' });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await readSse(res);
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('user_message');
    expect(types).toContain('run_start');
    expect(types).toContain('text_delta');
    expect(types).toContain('tool_start');
    expect(types).toContain('data_changed');
    expect(types).toContain('context');
    expect(types.at(-1)).toBe('done');
    expect(llm.requests[0].system).toContain('Europe/Paris');

    const { body } = await client.json('GET', `/api/sessions/${sessionId}`);
    expect(body.session.title).toBe('I am an engineer');
    expect(body.session.messages).toMatchObject([
      { role: 'user', content: 'I am an engineer' },
      { role: 'assistant', content: 'Saved your headline. **What roles** are you targeting?' },
    ]);
    expect(body.session.activity.map((e: any) => e.type)).not.toContain('text_delta');
    expect(body.session.activity.some((e: any) => e.type === 'tool_end' && e.name === 'editProfile' && e.ok)).toBe(true);
    expect((await client.json('GET', '/api/profile')).body.profile.headline).toBe('Engineer');
  });

  it('sends the previous transcript (including tool results) on the next turn', async () => {
    const llm = new ScriptedLlm({ coordinator: [call('readProfile', {}), reply('first'), reply('second')] });
    const { client, sessionId } = await setup(llm);
    await readSse(await client.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'one' }));
    await readSse(await client.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'two' }));
    const roles = llm.requests.at(-1)!.req.messages.map((m) => m.role);
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user']);
    expect((await client.json('GET', `/api/sessions/${sessionId}`)).body.session.messages.map((m: any) => m.content)).toEqual(['one', 'first', 'two', 'second']);
  });

  it('rejects a second message while busy, supports re-attaching and stopping', async () => {
    const llm = new ScriptedLlm({ coordinator: [reply('slow reply')] }, { delayMs: 400 });
    const { client, sessionId } = await setup(llm);
    const first = client.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'hello' });
    await new Promise((r) => setTimeout(r, 50));
    expect((await client.json('GET', `/api/sessions/${sessionId}`)).body.session.busy).toBe(true);
    const second = await client.json('POST', `/api/sessions/${sessionId}/messages`, { content: 'again' });
    expect(second.status).toBe(409);

    const attached = readSse(await client.req('GET', `/api/sessions/${sessionId}/stream`));
    expect((await client.json('POST', `/api/sessions/${sessionId}/stop`, {})).body).toEqual({ stopped: true });
    const [events, replay] = await Promise.all([readSse(await first), attached]);
    expect(events.at(-1)?.type).toBe('done');
    expect(replay[0]).toMatchObject({ type: 'user_message', content: 'hello' });
    expect(replay.at(-1)?.type).toBe('done');
    const session = (await client.json('GET', `/api/sessions/${sessionId}`)).body.session;
    expect(session.busy).toBe(false);
    expect(session.messages.at(-1).content).toBe('_(Stopped.)_');
    // When idle, the stream endpoint just says done.
    expect((await readSse(await client.req('GET', `/api/sessions/${sessionId}/stream`))).map((e) => e.type)).toEqual(['done']);
  });

  it('records model failures in the transcript', async () => {
    const { client, sessionId } = await setup(new ScriptedLlm({ coordinator: [new Error('upstream 503')] }));
    const events = await readSse(await client.req('POST', `/api/sessions/${sessionId}/messages`, { content: 'hi' }));
    expect(events.some((e) => e.type === 'error' && e.message === 'upstream 503')).toBe(true);
    const session = (await client.json('GET', `/api/sessions/${sessionId}`)).body.session;
    expect(session.messages.at(-1).content).toMatch(/something went wrong.*upstream 503/);
  });

  it('validates message bodies', async () => {
    const { client, sessionId } = await setup(new ScriptedLlm());
    expect((await client.json('POST', `/api/sessions/${sessionId}/messages`, { content: '   ' })).status).toBe(400);
  });
});
