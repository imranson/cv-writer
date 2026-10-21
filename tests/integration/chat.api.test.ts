import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRequest } from '../../src/llm/types';
import { ScriptedLLM, makeDeps, parseSSE, tempDir } from '../helpers';
import { TestClient, buildApp } from '../helpers/http';

let tmp: Awaited<ReturnType<typeof tempDir>>;
beforeEach(async () => (tmp = await tempDir()));
afterEach(() => tmp.cleanup());

/** Finds the jobId the coordinator created earlier in this conversation. */
function createdJobId(req: ChatRequest): string {
  const tool = req.messages.find((m) => m.role === 'tool' && m.tool_name === 'editJob');
  return JSON.parse(tool!.content).job.id;
}
function briefJobId(req: ChatRequest): string {
  return /jobId: (\w+)/.exec(req.messages[1].content)![1];
}
function criticReview(req: ChatRequest) {
  const jobId = /jobId (\w+)/.exec(req.messages[1].content)![1];
  return {
    tools: [
      ['loadSkill', { name: 'cv-review-rubric' }],
      ['readCV', { jobId }],
      ['readPreferences', { jobId }],
      ['readJob', { jobId }],
      ['evalMath', { expression: '(8*3 + 7*2 + 8*2 + 9 + 9 + 8) / 10' }],
    ] as Array<[string, Record<string, unknown>]>,
  };
}

describe('end-to-end CV workflow over the chat API', () => {
  it('coordinator records profile and job, delegates to writer and critic, and streams all activity', async () => {
    const llm = new ScriptedLLM({
      coordinator: [
        { content: 'Great, saving that.', tools: [['loadSkill', { name: 'profile-interview' }], ['editProfile', { op: 'merge', value: { name: 'Ada Lovelace', skills: ['Python'] } }]] },
        { tools: [['editJob', { job: { title: 'Data Engineer', company: 'Acme', description: 'Python, AWS' } }]] },
        (req) => ({
          tools: [
            ['editPreferences', { jobId: createdJobId(req), preferences: { maxPages: 1 } }],
            ['callWriter', { jobId: createdJobId(req), instructions: 'Draft a one-page CV' }],
          ],
        }),
        (req) => ({ tools: [['callCritic', { jobId: createdJobId(req), focus: 'keywords' }]] }),
        { content: 'Your CV is ready in the **CV** tab. The critic scored it 8/10.' },
      ],
      writer: [
        (req) => ({ tools: [['readProfile', {}], ['readCV', { jobId: briefJobId(req) }]] }),
        (req) => ({
          tools: [
            ['editCV', { jobId: briefJobId(req), html: '<header class="cv-header"><h1>Ada Lovelace</h1></header><section><h2>Skills</h2><p>Python</p></section>' }],
            ['editCSS', { jobId: briefJobId(req), edits: [{ find: '--accent: #1f5f8b', replace: '--accent: #0b6e4f' }] }],
          ],
        }),
        (req) => ({ tools: [['callCritic', { jobId: briefJobId(req) }]] }),
        { content: 'Drafted a one-page CV; critic gave 7/10, fixed keyword gaps.' },
      ],
      // The critic runs twice: once for the writer, once for the coordinator.
      critic: [criticReview, { content: 'Score: 7/10\nMissing keywords: AWS' }, criticReview, { content: 'Score: 8/10' }],
    });
    const deps = makeDeps(tmp.dir, llm);
    const client = new TestClient(buildApp(deps));
    const user = await client.register('ada@example.com');
    const { session } = (await client.post('/api/sessions')).body;

    const res = await client.request('POST', `/api/sessions/${session.id}/messages`, { content: 'I am Ada, a Python developer. Help me apply to Acme.' });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = parseSSE(await res.text());

    // Streaming text, tool calls/results for every agent, subagent runs and context usage all reach the client.
    expect(events.at(-1)).toMatchObject({ type: 'done', text: 'Your CV is ready in the **CV** tab. The critic scored it 8/10.' });
    expect(events.some((e) => e.type === 'delta')).toBe(true);
    const calls = events.filter((e) => e.type === 'tool_call').map((e) => `${e.agent}:${e.name}`);
    expect(calls).toEqual([
      'coordinator:loadSkill',
      'coordinator:editProfile',
      'coordinator:editJob',
      'coordinator:editPreferences',
      'coordinator:callWriter',
      'writer:readProfile',
      'writer:readCV',
      'writer:editCV',
      'writer:editCSS',
      'writer:callCritic',
      'critic:loadSkill',
      'critic:readCV',
      'critic:readPreferences',
      'critic:readJob',
      'critic:evalMath',
      'coordinator:callCritic',
      'critic:loadSkill',
      'critic:readCV',
      'critic:readPreferences',
      'critic:readJob',
      'critic:evalMath',
    ]);
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results).toHaveLength(calls.length);
    expect(results.filter((r) => !r.ok)).toEqual([]);
    expect(new Set(events.filter((e) => e.type === 'usage').map((e) => e.agent))).toEqual(new Set(['coordinator', 'writer', 'critic']));
    expect(events.filter((e) => e.type === 'agent_start').map((e) => e.agent)).toEqual(['coordinator', 'writer', 'critic', 'critic']);
    expect(new Set(events.filter((e) => e.type === 'data_changed').map((e) => e.kind))).toEqual(new Set(['profile', 'job', 'preferences', 'cv', 'css']));

    // Subagents see their own system prompt, datetime and context window.
    const writerSystem = llm.callsFor('writer')[0].request.messages[0].content;
    expect(writerSystem).toMatch(/^You are the Writer/);
    expect(writerSystem).toContain('# System information');
    expect(llm.callsFor('writer')[0].request.messages[1].content).toContain('Draft a one-page CV');

    // Everything was persisted for this user.
    const jobId = (await client.get('/api/jobs')).body.jobs[0].id;
    expect((await client.get('/api/profile')).body.profile).toMatchObject({ name: 'Ada Lovelace', skills: ['Python'] });
    expect((await client.get(`/api/jobs/${jobId}/cv`)).body.html).toContain('<h1>Ada Lovelace</h1>');
    expect((await client.get(`/api/jobs/${jobId}/css`)).body.css).toContain('--accent: #0b6e4f');
    expect((await client.get(`/api/jobs/${jobId}/preferences`)).body.preferences.maxPages).toBe(1);

    const saved = (await client.get(`/api/sessions/${session.id}`)).body.session;
    expect(saved.title).toBe('I am Ada, a Python developer. Help me apply to Acme.');
    expect(saved.events.filter((e: any) => e.type === 'tool_call')).toHaveLength(calls.length);
    expect(Object.keys(saved.usage).sort()).toEqual(['coordinator', 'critic', 'writer']);
    expect(saved.messages.at(-1)).toMatchObject({ role: 'assistant', content: expect.stringContaining('CV is ready') });
    expect(user.id).toBeTruthy();
  });

  it('tells the coordinator which job is open in the UI', async () => {
    const llm = new ScriptedLLM();
    const client = new TestClient(buildApp(makeDeps(tmp.dir, llm)));
    await client.register('ada@example.com');
    const { job } = (await client.post('/api/jobs', { title: 'Designer', company: 'Globex' })).body;
    const { session } = (await client.post('/api/sessions')).body;
    await (await client.request('POST', `/api/sessions/${session.id}/messages`, { content: 'hi', activeJobId: job.id })).text();
    expect(llm.requests[0].request.messages[0].content).toContain(`Designer at Globex (jobId: ${job.id})`);
  });

  it('streams an error event when the model fails, and keeps the session usable', async () => {
    const llm = new ScriptedLLM();
    let fail = true;
    const orig = llm.chat.bind(llm);
    llm.chat = async (req) => {
      if (fail) {
        fail = false;
        throw new Error('unauthorized: invalid API key');
      }
      return orig(req);
    };
    const client = new TestClient(buildApp(makeDeps(tmp.dir, llm)));
    await client.register('ada@example.com');
    const { session } = (await client.post('/api/sessions')).body;
    const first = parseSSE(await (await client.request('POST', `/api/sessions/${session.id}/messages`, { content: 'hi' })).text());
    expect(first).toContainEqual(expect.objectContaining({ type: 'error', message: 'unauthorized: invalid API key' }));
    const second = parseSSE(await (await client.request('POST', `/api/sessions/${session.id}/messages`, { content: 'again' })).text());
    expect(second.at(-1)).toMatchObject({ type: 'done', text: 'coordinator done' });
  });

  it('validates chat requests', async () => {
    const client = new TestClient(buildApp(makeDeps(tmp.dir)));
    await client.register('ada@example.com');
    const { session } = (await client.post('/api/sessions')).body;
    expect((await client.post(`/api/sessions/${session.id}/messages`, { content: '  ' })).status).toBe(400);
    expect((await client.post('/api/sessions/missing/messages', { content: 'hi' })).status).toBe(404);
  });

  it('returns 409 while a turn is running', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLLM();
    const orig = llm.chat.bind(llm);
    llm.chat = async (req) => (await gate, orig(req));
    const client = new TestClient(buildApp(makeDeps(tmp.dir, llm)));
    await client.register('ada@example.com');
    const { session } = (await client.post('/api/sessions')).body;
    const first = client.request('POST', `/api/sessions/${session.id}/messages`, { content: 'one' });
    const firstRes = await first;
    const bodyPromise = firstRes.text();
    await new Promise((r) => setTimeout(r, 20));
    expect((await client.post(`/api/sessions/${session.id}/messages`, { content: 'two' })).status).toBe(409);
    expect((await client.get(`/api/sessions/${session.id}`)).body.running).toBe(true);
    expect((await client.del(`/api/sessions/${session.id}`)).status).toBe(409);
    release();
    await bodyPromise;
  });
});
