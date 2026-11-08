import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, TestClient, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
let ann: TestClient;
let bob: TestClient;
const renders: any[] = [];

beforeAll(async () => {
  env = await createTestEnv({
    pdf: {
      render: async (...args: any[]) => {
        renders.push(args);
        return Buffer.from('%PDF-1.4 << /Type /Page >> << /Type /Page >> %%EOF');
      },
    },
  });
  ann = new TestClient(env.app);
  bob = new TestClient(env.app);
  await ann.register('ann@example.com', 'password123', 'Ann Example');
  await bob.register('bob@example.com', 'password123', 'Bob');
});
afterAll(() => env.close());

describe('profile API', () => {
  it('reads and replaces the profile JSON', async () => {
    expect((await ann.json('GET', '/api/profile')).body).toEqual({ profile: { name: 'Ann Example' } });
    const saved = await ann.json('PUT', '/api/profile', { profile: { name: 'Ann Example', skills: ['Go'] } });
    expect(saved.body.profile.skills).toEqual(['Go']);
    expect((await ann.json('PUT', '/api/profile', { profile: [1, 2] })).status).toBe(400);
    expect((await ann.req('PUT', '/api/profile', '{bad json')).status).toBe(400);
  });
});

describe('jobs, CV, CSS and preferences API', () => {
  let jobId: string;

  it('creates a job with its CV bundle and lists it', async () => {
    const created = await ann.json('POST', '/api/jobs', { job: { title: 'Engineer', company: 'Acme' } });
    expect(created.status).toBe(201);
    jobId = created.body.job.id;
    expect((await ann.json('GET', '/api/jobs')).body.jobs).toMatchObject([{ id: jobId, title: 'Engineer', company: 'Acme', cvChars: 0 }]);
    const detail = await ann.json('GET', `/api/jobs/${jobId}`);
    expect(detail.body.job.data).toEqual({ title: 'Engineer', company: 'Acme' });
    expect(detail.body.cv).toMatchObject({ html: '', preferences: { paperSize: 'A4' } });
    expect(detail.body.cv.css).toContain('@page');
  });

  it('updates job JSON, CV HTML (sanitised), raw CSS and preferences', async () => {
    expect((await ann.json('PUT', `/api/jobs/${jobId}`, { job: { title: 'Senior Engineer', company: 'Acme' } })).body.job.data.title).toBe('Senior Engineer');
    const cv = await ann.json('PUT', `/api/jobs/${jobId}/cv`, { html: '<h1>Ann</h1><script>x</script>' });
    expect(cv.body.html).toBe('<h1>Ann</h1>');
    expect((await ann.json('PUT', `/api/jobs/${jobId}/css`, { css: 'h1 { color: navy; }' })).body.css).toBe('h1 { color: navy; }');
    expect((await ann.json('PUT', `/api/jobs/${jobId}/css`, { css: '</style><script>' })).status).toBe(400);
    expect((await ann.json('PUT', `/api/jobs/${jobId}/preferences`, { preferences: { maxPages: 1, paperSize: 'Letter' } })).body.preferences).toEqual({ maxPages: 1, paperSize: 'Letter' });
  });

  it('serves a sandboxed printable CV page', async () => {
    const res = await ann.req('GET', `/api/jobs/${jobId}/cv.html`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('content-security-policy')).toContain('sandbox');
    const html = await res.text();
    expect(html).toContain('<style>\nh1 { color: navy; }');
    expect(html).toContain('<h1>Ann</h1>');
  });

  it('downloads the CV as PDF with preferences applied', async () => {
    const res = await ann.req('GET', `/api/jobs/${jobId}/cv.pdf`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="CV - Ann Example - Acme - Senior Engineer.pdf"');
    expect(res.headers.get('x-page-count')).toBe('2');
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
    expect(renders.at(-1).slice(0, 3)).toEqual(['<h1>Ann</h1>', 'h1 { color: navy; }', { maxPages: 1, paperSize: 'Letter' }]);
    expect((await ann.req('GET', `/api/jobs/${jobId}/cv.pdf?inline=1`)).headers.get('content-disposition')).toMatch(/^inline/);
  });

  it('hides one user’s jobs from another', async () => {
    for (const [method, path, body] of [
      ['GET', `/api/jobs/${jobId}`],
      ['PUT', `/api/jobs/${jobId}`, { job: {} }],
      ['PUT', `/api/jobs/${jobId}/cv`, { html: 'x' }],
      ['PUT', `/api/jobs/${jobId}/css`, { css: 'x' }],
      ['PUT', `/api/jobs/${jobId}/preferences`, { preferences: {} }],
      ['GET', `/api/jobs/${jobId}/cv.pdf`],
      ['GET', `/api/jobs/${jobId}/cv.html`],
      ['DELETE', `/api/jobs/${jobId}`],
    ] as const) {
      expect((await bob.req(method, path, body)).status, `${method} ${path}`).toBe(404);
    }
    expect((await bob.json('GET', '/api/jobs')).body.jobs).toEqual([]);
  });

  it('deletes a job and its CV', async () => {
    expect((await ann.json('DELETE', `/api/jobs/${jobId}`)).body).toEqual({ ok: true });
    expect((await ann.json('GET', `/api/jobs/${jobId}`)).status).toBe(404);
  });
});

describe('system & misc endpoints', () => {
  it('describes agents, models, context windows, tools and skills', async () => {
    const { body } = await ann.json('GET', '/api/system');
    expect(body.database).toBe('pglite');
    expect(body.agents.map((a: any) => a.name)).toEqual(['coordinator', 'writer', 'critic']);
    expect(body.agents[0]).toMatchObject({ model: 'kimi-k2.6:cloud', contextWindow: 32768 });
    expect(body.agents[1].skills.map((s: any) => s.name)).toEqual(['ats-cv-writing']);
    expect(body.agents[2].tools).toContain('evalMath');
  });

  it('reports health, sets security headers and 404s unknown API routes', async () => {
    const health = await ann.req('GET', '/api/health');
    expect(await health.json()).toEqual({ ok: true, db: 'pglite' });
    expect(health.headers.get('x-content-type-options')).toBe('nosniff');
    expect(health.headers.get('content-security-policy')).toContain("script-src 'self'");
    expect((await ann.req('GET', '/api/nope')).status).toBe(404);
  });

  it('serves the single-page client', async () => {
    const res = await new TestClient(env.app).req('GET', '/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app">');
    expect(await (await new TestClient(env.app).req('GET', '/styles.css')).text()).toContain('.shell');
  });
});
