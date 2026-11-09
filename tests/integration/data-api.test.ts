import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, FakePdf, register, TestClient } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
let ada: TestClient;
let bob: TestClient;
let jobId: string;

beforeAll(async () => {
  ctx = await createTestApp();
  ada = new TestClient(ctx.app);
  bob = new TestClient(ctx.app);
  await register(ada, 'ada@example.com', 'Ada Lovelace');
  await register(bob, 'bob@example.com', 'Bob');
});
afterAll(() => ctx.db.close());

describe('health & system', () => {
  it('health is public', async () => {
    expect((await new TestClient(ctx.app).json('GET', '/api/health')).body).toEqual({ ok: true, db: 'pglite' });
  });
  it('reports models and context windows', async () => {
    const res = await ada.json('GET', '/api/system');
    expect(res.body.models).toEqual({ coordinator: 'test-coord', writer: 'test-writer', critic: 'test-critic' });
    expect(res.body.contextWindows.coordinator).toBe(32000);
  });
  it('lists skills per agent type', async () => {
    const res = await ada.json('GET', '/api/skills');
    expect(Object.keys(res.body)).toEqual(['coordinator', 'writer', 'critic']);
    expect(res.body.critic[0].name).toBe('cv-review-rubric');
  });
});

describe('profile', () => {
  it('reads the default profile and replaces it', async () => {
    const get = await ada.json('GET', '/api/profile');
    expect(get.body.profile.basics.name).toBe('Ada Lovelace');
    const put = await ada.json('PUT', '/api/profile', { profile: { basics: { name: 'Ada L.' }, skills: ['Maths'] } });
    expect(put.body.profile).toEqual({ basics: { name: 'Ada L.' }, skills: ['Maths'] });
    expect((await ada.json('PUT', '/api/profile', { profile: [1, 2] })).status).toBe(400);
    expect((await ada.json('PUT', '/api/profile', 'nope')).status).toBe(400);
  });
});

describe('jobs, CV, CSS, preferences', () => {
  it('creates and lists jobs', async () => {
    const created = await ada.json('POST', '/api/jobs', { job: { title: 'Engineer', company: 'Acme' } });
    expect(created.status).toBe(201);
    jobId = created.body.job.id;
    const list = await ada.json('GET', '/api/jobs');
    expect(list.body.jobs).toEqual([expect.objectContaining({ id: jobId, title: 'Engineer', company: 'Acme', hasCv: false })]);
    expect((await ada.json('POST', '/api/jobs', { job: 'x' })).status).toBe(400);
  });

  it('updates job JSON', async () => {
    const res = await ada.json('PUT', `/api/jobs/${jobId}`, { job: { title: 'Senior Engineer', company: 'Acme' } });
    expect(res.body.job.data.title).toBe('Senior Engineer');
    expect((await ada.json('PUT', `/api/jobs/${jobId}`, {})).status).toBe(400);
  });

  it('reads/writes CV HTML, raw CSS and preferences', async () => {
    expect((await ada.json('GET', `/api/jobs/${jobId}/cv`)).body.cv.html).toBe('');
    await ada.json('PUT', `/api/jobs/${jobId}/cv`, { html: '<h1>Ada</h1><script>x()</script>' });
    expect((await ada.json('GET', `/api/jobs/${jobId}/cv`)).body.cv.html).toContain('<h1>Ada</h1>');
    const css = await ada.json('GET', `/api/jobs/${jobId}/css`);
    expect(css.body.css).toContain('@page');
    await ada.json('PUT', `/api/jobs/${jobId}/css`, { css: 'h1 { color: navy; }' });
    expect((await ada.json('GET', `/api/jobs/${jobId}/css`)).body.css).toBe('h1 { color: navy; }');
    const prefs = await ada.json('PUT', `/api/jobs/${jobId}/preferences`, { preferences: { pageSize: 'Letter', maxPages: 1 } });
    expect(prefs.body.preferences).toEqual({ pageSize: 'Letter', maxPages: 1 });
    expect((await ada.json('PUT', `/api/jobs/${jobId}/cv`, { html: 5 })).status).toBe(400);
    expect((await ada.json('PUT', `/api/jobs/${jobId}/css`, {})).status).toBe(400);
    expect((await ada.json('PUT', `/api/jobs/${jobId}/preferences`, { preferences: 'x' })).status).toBe(400);
  });

  it('serves a sandboxed, sanitized preview document', async () => {
    const res = await ada.request('GET', `/api/jobs/${jobId}/cv/preview`);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await res.text();
    expect(html).toContain('<style>h1 { color: navy; }</style>');
    expect(html).toContain('<h1>Ada</h1>');
    expect(html).not.toContain('<script>');
  });

  it('renders the PDF with the preference page size', async () => {
    const res = await ada.request('GET', `/api/jobs/${jobId}/cv.pdf?download=1`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-page-count')).toBe('1');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Ada_L_Acme_CV.pdf"');
    expect((ctx.pdf as FakePdf).renders.at(-1)).toMatchObject({ pageSize: 'Letter', css: 'h1 { color: navy; }' });
  });

  it('returns 404 for a PDF of an empty CV', async () => {
    const empty = await ada.json('POST', '/api/jobs', { job: { title: 'Empty' } });
    expect((await ada.json('GET', `/api/jobs/${empty.body.job.id}/cv.pdf`)).status).toBe(404);
  });

  it('isolates accounts at the API level', async () => {
    for (const [method, url, body] of [
      ['GET', `/api/jobs/${jobId}`],
      ['PUT', `/api/jobs/${jobId}`, { job: {} }],
      ['GET', `/api/jobs/${jobId}/cv`],
      ['PUT', `/api/jobs/${jobId}/cv`, { html: 'x' }],
      ['GET', `/api/jobs/${jobId}/css`],
      ['GET', `/api/jobs/${jobId}/preferences`],
      ['GET', `/api/jobs/${jobId}/cv/preview`],
      ['GET', `/api/jobs/${jobId}/cv.pdf`],
      ['DELETE', `/api/jobs/${jobId}`],
    ] as [string, string, unknown?][]) {
      expect((await bob.json(method, url, body)).status, `${method} ${url}`).toBe(404);
    }
    expect((await bob.json('GET', '/api/jobs')).body.jobs).toEqual([]);
  });

  it('deletes a job', async () => {
    expect((await ada.json('DELETE', `/api/jobs/${jobId}`)).body).toEqual({ ok: true });
    expect((await ada.json('GET', `/api/jobs/${jobId}`)).status).toBe(404);
  });
});

describe('chat sessions API', () => {
  it('creates, renames, lists and deletes chats', async () => {
    const created = await ada.json('POST', '/api/chats', { title: 'My chat' });
    expect(created.status).toBe(201);
    const id = created.body.chat.id;
    const renamed = await ada.json('PATCH', `/api/chats/${id}`, { title: 'Renamed' });
    expect(renamed.body.chat.title).toBe('Renamed');
    const got = await ada.json('GET', `/api/chats/${id}`);
    expect(got.body).toMatchObject({ chat: { id, title: 'Renamed', turns: [], focusJobId: null }, live: null, context: { transcriptTokens: 0 } });
    expect((await bob.json('GET', `/api/chats/${id}`)).status).toBe(404);
    expect((await ada.json('GET', '/api/chats')).body.chats.map((c: any) => c.id)).toContain(id);
    expect((await ada.json('DELETE', `/api/chats/${id}`)).body).toEqual({ ok: true });
    expect((await ada.json('GET', `/api/chats/${id}`)).status).toBe(404);
  });

  it('unknown API routes return JSON 404', async () => {
    expect((await ada.json('GET', '/api/nope')).status).toBe(404);
  });
});
