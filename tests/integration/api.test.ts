import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CV_CSS } from '../../src/cv/defaultStyle.js';
import { buildTestApp, collectEvents } from '../support/app.js';
import { ADA_PROFILE, journeyLlm } from '../support/journey.js';
import { say, ScriptedLLM } from '../support/scriptedLlm.js';

type TestApp = Awaited<ReturnType<typeof buildTestApp>>;
let t: TestApp;
let llm: ScriptedLLM;

beforeAll(async () => {
  llm = journeyLlm();
  t = await buildTestApp(llm);
});
afterAll(() => t.cleanup());

const req = (p: string, init?: RequestInit) => t.app.request(p, init);
const postJson = (p: string, body: unknown, method = 'POST') =>
  req(p, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('end-to-end journey over HTTP (scripted model)', () => {
  let sessionId: string;
  let jobId: string;

  it('creates a chat session', async () => {
    const res = await req('/api/sessions', { method: 'POST' });
    expect(res.status).toBe(201);
    sessionId = (await res.json()).id;
    expect((await (await req('/api/sessions')).json())[0]).toMatchObject({ id: sessionId, running: false });
  });

  it('streams one coordinator turn that builds profile, job and CV via writer and critic', async () => {
    const res = await postJson(`/api/sessions/${sessionId}/messages`, { text: 'Hi, I am Ada. Please write my CV for Acme.' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const events = await collectEvents(res);

    expect(events.at(-1)).toMatchObject({ type: 'done' });
    const toolCalls = events.filter((e) => e.type === 'tool_call').map((e) => `${(e as any).agent}:${(e as any).name}`);
    expect(toolCalls).toEqual([
      'coordinator:writeProfile',
      'coordinator:writeJob',
      'coordinator:callWriter',
      'writer:readProfile',
      'writer:writeCV',
      'writer:callCritic',
      'critic:readCV',
      'critic:readJob',
    ]);
    expect(events.filter((e) => e.type === 'data_changed').map((e) => (e as any).kind)).toEqual(['profile', 'job', 'cv']);
    const said = events.map((e) => (e.type === 'delta' ? e.content : '')).join('');
    expect(said).toContain('Thanks Ada, saving your profile.');
    expect(said).toContain('ready in the preview panel');
    expect(said).not.toContain('WRITER REPORT');
    const ctx = events.filter((e) => e.type === 'context' && (e as any).depth === 0).at(-1) as any;
    expect(ctx.contextWindow).toBe(262_144);
    expect(ctx.usedTokens).toBeGreaterThan(0);
  });

  it('persisted every data type in its own directory', async () => {
    const dirs = (await readdir(t.dir)).sort();
    expect(dirs).toEqual(['cv-preferences', 'cv-styles', 'cvs', 'jobs', 'profiles', 'sessions']);
    for (const d of dirs) expect((await readdir(path.join(t.dir, d))).length).toBe(1);
  });

  it('exposes profile, jobs and the CV (HTML + CSS + preferences) to the UI', async () => {
    const profiles = await (await req('/api/profiles')).json();
    expect(profiles).toHaveLength(1);
    expect(await (await req(`/api/profiles/${profiles[0].id}`)).json()).toMatchObject({ name: ADA_PROFILE.name });

    const jobs = await (await req('/api/jobs')).json();
    expect(jobs).toEqual([expect.objectContaining({ title: 'Senior TypeScript Engineer @ Acme', profileId: profiles[0].id, hasCv: true })]);
    jobId = jobs[0].id;
    expect((await (await req(`/api/jobs?profileId=${profiles[0].id}`)).json())).toHaveLength(1);
    expect((await (await req(`/api/jobs?profileId=someone-else`)).json())).toHaveLength(0);

    const cv = await (await req(`/api/cvs/${jobId}`)).json();
    expect(cv).toMatchObject({ exists: true, css: DEFAULT_CV_CSS, preferences: { tone: 'formal', pages: 1 } });
    expect(cv.html).toContain('<h1>Ada Lovelace</h1>');
    expect(await (await req('/api/cvs')).json()).toEqual([expect.objectContaining({ id: jobId })]);
  });

  it('serves the rendered CV document with a strict CSP', async () => {
    const res = await req(`/api/cvs/${jobId}/document`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('<h1>Ada Lovelace</h1>');
    expect(html).toContain('.cv-header');
    expect(html).toContain('<title>CV – Senior TypeScript Engineer @ Acme</title>');
  });

  it('lets the user edit the raw CSS', async () => {
    const res = await postJson(`/api/cvs/${jobId}/css`, { css: 'h1 { color: rebeccapurple; }' }, 'PUT');
    expect(res.status).toBe(200);
    expect((await res.json()).css).toBe('h1 { color: rebeccapurple; }');
    expect(await (await req(`/api/cvs/${jobId}/document`)).text()).toContain('rebeccapurple');
    expect((await postJson(`/api/cvs/${jobId}/css`, { nope: 1 }, 'PUT')).status).toBe(400);
  });

  it('stores the chat session independently with full history', async () => {
    const session = await (await req(`/api/sessions/${sessionId}`)).json();
    expect(session).toMatchObject({ id: sessionId, title: 'Hi, I am Ada. Please write my CV for Acme.', running: false });
    expect(session.messages.map((m: any) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(session.usage.contextWindow).toBe(262_144);
  });
});

describe('API validation and errors', () => {
  it('rejects invalid ids, unknown resources and bad input', async () => {
    expect((await req('/api/profiles/..%2F..%2Fetc')).status).toBe(400);
    expect((await req('/api/jobs/NOPE')).status).toBe(400);
    expect((await req('/api/jobs/job-missing')).status).toBe(404);
    expect((await req('/api/cvs/job-missing/document')).status).toBe(404);
    expect((await req('/api/cvs/job-missing/pdf')).status).toBe(404);
    expect((await req('/api/sessions/chat-missing')).status).toBe(404);
    expect((await postJson('/api/sessions/chat-missing/messages', { text: 'hi' })).status).toBe(404);
    const s = await (await req('/api/sessions', { method: 'POST' })).json();
    expect((await postJson(`/api/sessions/${s.id}/messages`, { text: '   ' })).status).toBe(400);
    expect((await req(`/api/sessions/${s.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await req(`/api/sessions/${s.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('returns 409 while a chat is already running, and can stop it', async () => {
    const slow = new ScriptedLLM({ coordinator: () => say('done') });
    slow.delayMs = 5_000;
    const local = await buildTestApp(slow);
    try {
      const s = await (await local.app.request('/api/sessions', { method: 'POST' })).json();
      const send = (text: string) =>
        local.app.request(`/api/sessions/${s.id}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const first = send('one');
      await new Promise((r) => setTimeout(r, 50));
      expect((await send('two')).status).toBe(409);
      expect(await (await local.app.request(`/api/sessions/${s.id}`)).json()).toMatchObject({ running: true });
      expect(await (await local.app.request(`/api/sessions/${s.id}/stop`, { method: 'POST' })).json()).toEqual({ stopped: true });
      const events = await collectEvents(await first);
      expect(events.at(-1)).toEqual({ type: 'stopped' });
    } finally {
      await local.cleanup();
    }
  });
});

describe('static client', () => {
  it('serves the page, styles and the bundled TypeScript client', async () => {
    expect(await (await req('/')).text()).toContain('<script type="module" src="/app.js">');
    expect((await req('/app.css')).headers.get('content-type')).toContain('text/css');
    const js = await req('/app.js');
    expect(js.headers.get('content-type')).toContain('javascript');
    expect(await js.text()).toContain('/api/sessions');
    expect(await (await req('/api/status')).json()).toMatchObject({ contextWindow: 262_144, webSearch: true });
  });
});
