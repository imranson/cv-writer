import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService } from '../../src/agents/conversation.ts';
import { createApp, pdfFileName } from '../../src/server/app.ts';
import { critiqueInput, CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { client } from '../support/http.ts';
import { call, say, waitForAbort } from '../support/scriptedModel.ts';

let env: TestEnv;
let api: ReturnType<typeof client>;
let conversation: ConversationService;

beforeEach(async () => {
  env = await makeEnv();
  conversation = new ConversationService(env.deps, { compactThreshold: 0.8 });
  api = client(createApp({ deps: env.deps, conversation }));
});
afterEach(() => env.cleanup());

async function createJob() {
  return (await api.post('/api/jobs', { title: 'Senior PM', company: 'Brightwave', listing: LISTING })).data;
}

describe('API: basics', () => {
  it('reports health and config', async () => {
    expect((await api.get('/api/health')).data).toEqual({ ok: true });
    expect((await api.get('/api/config')).data).toEqual({ models: { coordinator: 'coordinator', writer: 'writer', critic: 'critic' }, host: undefined, contextLength: 100_000, pdf: true });
  });

  it('returns JSON errors for unknown routes, bad ids and bad bodies', async () => {
    expect((await api.get('/api/nope')).status).toBe(404);
    expect((await api.get('/api/jobs/missing-job')).status).toBe(404);
    expect((await api.get('/api/jobs/..%2F..%2Fetc')).status).toBe(400);
    const bad = await api.post('/api/jobs', { title: '' });
    expect(bad.status).toBe(400);
    expect(bad.data.error).toMatch(/title/);
    expect((await api.put('/api/profile', 'not json')).status).toBe(400);
  });
});

describe('API: profile, jobs, CVs, styles', () => {
  it('reads and writes the profile', async () => {
    expect((await api.get('/api/profile')).data).toEqual({ markdown: '' });
    expect((await api.put('/api/profile', { markdown: PROFILE })).data.markdown).toBe(PROFILE);
  });

  it('supports the job lifecycle', async () => {
    const job = await createJob();
    expect(job.id).toMatch(/^brightwave-senior-pm-/);
    expect((await api.get(`/api/jobs/${job.id}`)).data.listing).toBe(LISTING);
    expect((await api.put(`/api/jobs/${job.id}`, { company: 'Brightwave Ltd' })).data.company).toBe('Brightwave Ltd');
    expect((await api.get('/api/jobs')).data).toEqual([expect.objectContaining({ id: job.id, hasCv: false })]);
    expect((await api.del(`/api/jobs/${job.id}`)).status).toBe(204);
    expect((await api.get('/api/jobs')).data).toEqual([]);
  });

  it('edits CVs with versions and restore, and stores per-CV CSS', async () => {
    const job = await createJob();
    expect((await api.get(`/api/jobs/${job.id}/cv`)).data).toEqual({ html: '' });
    expect((await api.put(`/api/jobs/${job.id}/cv`, { html: '<h1 onclick="x">V1</h1>' })).data.html).toBe('<h1>V1</h1>\n');
    await api.put(`/api/jobs/${job.id}/cv`, { html: '<h1>V2</h1>' });
    const versions = (await api.get(`/api/jobs/${job.id}/cv/versions`)).data;
    expect(versions).toHaveLength(2);
    expect(versions[0].source).toBe('user');
    const oldest = versions[1].id;
    expect((await api.get(`/api/jobs/${job.id}/cv/versions/${oldest}`)).data.html).toBe('<h1>V1</h1>\n');
    expect((await api.post(`/api/jobs/${job.id}/cv/versions/${oldest}/restore`)).data.html).toBe('<h1>V1</h1>\n');
    expect((await api.get(`/api/jobs/${job.id}/cv/versions/nope`)).status).toBe(404);

    expect((await api.get(`/api/jobs/${job.id}/style`)).data.css).toContain('@page');
    await api.put(`/api/jobs/${job.id}/style`, { css: 'h1 { color: red; }' });
    expect((await api.get(`/api/jobs/${job.id}/style`)).data.css).toBe('h1 { color: red; }');
    expect((await api.get('/api/style-presets')).data.map((p: { id: string }) => p.id)).toEqual(['classic', 'modern', 'compact']);
  });

  it('serves an HTML preview with a script-blocking CSP', async () => {
    const job = await createJob();
    await api.put(`/api/jobs/${job.id}/cv`, { html: CV_HTML });
    const res = await api.get(`/api/jobs/${job.id}/preview`);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.data).toContain('<h1>Alex Morgan</h1>');
    expect(res.data).toContain('@media screen');
  });

  it('renders PDFs with page count and a download filename', async () => {
    const job = await createJob();
    expect((await api.get(`/api/jobs/${job.id}/pdf`)).status).toBe(404);
    await api.put('/api/profile', { markdown: PROFILE });
    await api.put(`/api/jobs/${job.id}/cv`, { html: CV_HTML });
    env.pdf.pageCount = 2;
    const res = await api.get(`/api/jobs/${job.id}/pdf?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-page-count')).toBe('2');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="Alex Morgan - Brightwave - CV.pdf"/);
    expect((res.data as Buffer).subarray(0, 4).toString()).toBe('%PDF');
    expect((await api.get(`/api/jobs/${job.id}/pdf`)).headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('runs critiques and automated checks', async () => {
    const job = await createJob();
    await api.put('/api/profile', { markdown: PROFILE });
    await api.put(`/api/jobs/${job.id}/cv`, { html: CV_HTML });
    env.models.critic.push(call('submit_critique', critiqueInput()));
    const critique = (await api.post(`/api/jobs/${job.id}/critique`, {})).data;
    expect(critique).toMatchObject({ score: 89, verdict: 'ready' });
    expect((await api.get(`/api/jobs/${job.id}/critiques`)).data).toHaveLength(1);
    expect((await api.get('/api/jobs')).data[0]).toMatchObject({ score: 89, verdict: 'ready', critiqueStale: false });
    const checks = (await api.get(`/api/jobs/${job.id}/checks`)).data;
    expect(checks.pageCount).toBe(1);
    expect(checks.findings.some((f: { id: string }) => f.id === 'word-count')).toBe(true);
  });
});

describe('API: sessions and chat streaming', () => {
  it('creates, updates, lists and deletes sessions', async () => {
    const job = await createJob();
    const s = (await api.post('/api/sessions', {})).data;
    expect(s).toMatchObject({ title: 'New conversation', jobId: null, context: { estimated: true, limit: 100_000 } });
    expect((await api.patch(`/api/sessions/${s.id}`, { jobId: job.id, title: 'Renamed' })).data).toMatchObject({ jobId: job.id, title: 'Renamed' });
    expect((await api.patch(`/api/sessions/${s.id}`, { jobId: 'missing' })).status).toBe(404);
    expect((await api.get(`/api/sessions/${s.id}`)).data).toMatchObject({ running: false, jobId: job.id });
    expect((await api.get('/api/sessions')).data).toHaveLength(1);
    expect((await api.del(`/api/sessions/${s.id}`)).status).toBe(204);
    expect((await api.get(`/api/sessions/${s.id}`)).status).toBe(404);
  });

  it('streams a coordinator turn as server-sent events', async () => {
    const s = (await api.post('/api/sessions', {})).data;
    env.models.coordinator.push(call('update_profile', { markdown: PROFILE }), say('Saved your profile. **What role** are you targeting?'));
    const { status, events } = await api.chat(s.id, 'I am Alex Morgan, a product manager');
    expect(status).toBe(200);
    const types = events.map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['message', 'session', 'usage', 'tool_start', 'artifact', 'tool_end', 'text', 'context', 'done']));
    expect(events.every((e) => e._event === e.type)).toBe(true);
    expect(events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Saved your profile. **What role** are you targeting?');
    expect(events.find((e) => e.type === 'artifact')).toEqual({ type: 'artifact', kind: 'profile', _event: 'artifact' });
    expect((await api.get('/api/profile')).data.markdown).toBe(PROFILE);
    const session = (await api.get(`/api/sessions/${s.id}`)).data;
    expect(session.title).toBe('I am Alex Morgan, a product manager');
    expect(session.messages).toHaveLength(4);
    expect(session.context.estimated).toBe(false);
  });

  it('rejects empty messages, unknown sessions and concurrent turns', async () => {
    const s = (await api.post('/api/sessions', {})).data;
    expect((await api.chat(s.id, '   ')).status).toBe(400);
    expect((await api.chat('chat-missing1', 'hi')).status).toBe(404);

    env.models.coordinator.push((req) => waitForAbort(req));
    const first = api.chat(s.id, 'slow one');
    await new Promise((r) => setTimeout(r, 30));
    expect((await api.chat(s.id, 'second')).status).toBe(409);
    expect((await api.del(`/api/sessions/${s.id}`)).status).toBe(409);
    expect((await api.post(`/api/sessions/${s.id}/stop`)).data).toEqual({ stopped: true });
    expect((await first).events.at(-1).type).toBe('stopped');
  });

  it('compacts a session on request', async () => {
    const s = (await api.post('/api/sessions', {})).data;
    env.models.coordinator.push(...['a1', 'a2', 'a3', 'a4', 'Summary text'].map((t) => say(t)));
    for (const t of ['u1', 'u2', 'u3', 'u4']) await api.chat(s.id, t);
    const res = await api.post(`/api/sessions/${s.id}/compact`);
    expect(res.data).toMatchObject({ summary: 'Summary text', contextStart: 2 });
  });
});

describe('API: skills', () => {
  it('lists, creates, overrides and deletes skills', async () => {
    const list = (await api.get('/api/skills')).data;
    expect(list.length).toBeGreaterThanOrEqual(10);
    expect((await api.get('/api/skills/critique-rubric')).data.body).toContain('Critique rubric');
    const created = await api.post('/api/skills', { name: 'Tech CVs', description: 'For engineers', audience: ['writer'], body: 'Lead with impact.' });
    expect(created.status).toBe(201);
    expect(created.data).toMatchObject({ id: 'tech-cvs', source: 'user' });
    expect((await api.post('/api/skills', { id: 'tech-cvs', name: 'Again', body: 'x' })).status).toBe(400);
    expect((await api.post('/api/skills', { name: 'Bad', body: 'x', audience: ['robot'] })).status).toBe(400);
    const updated = await api.put('/api/skills/critique-rubric', { name: 'My rubric', description: 'Strict', body: 'Be strict.' });
    expect(updated.data).toMatchObject({ overridesBuiltin: true, body: 'Be strict.' });
    expect((await api.del('/api/skills/critique-rubric')).status).toBe(204);
    expect((await api.get('/api/skills/critique-rubric')).data.source).toBe('builtin');
    expect((await api.del('/api/skills/critique-rubric')).status).toBe(400);
    expect((await api.get('/api/skills/nope')).status).toBe(404);
  });
});

describe('pdfFileName', () => {
  it('builds a clean filename from the profile name and company', () => {
    expect(pdfFileName('# Zoë O’Brien\n', 'Acme/Co')).toBe('Zoë OBrien - AcmeCo - CV.pdf');
    expect(pdfFileName('', 'Acme')).toBe('Acme - CV.pdf');
  });
});
