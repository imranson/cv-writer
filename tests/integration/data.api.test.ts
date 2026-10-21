import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeDeps, tempDir } from '../helpers';
import { TestClient, buildApp } from '../helpers/http';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let client: TestClient;
beforeEach(async () => {
  tmp = await tempDir();
  client = new TestClient(buildApp(makeDeps(tmp.dir)));
  await client.register('ada@example.com');
});
afterEach(() => tmp.cleanup());

describe('profile API', () => {
  it('reads the default and saves JSON', async () => {
    expect((await client.get('/api/profile')).body.profile).toHaveProperty('experience', []);
    await client.put('/api/profile', { profile: { name: 'Ada', skills: ['Python'] } });
    expect((await client.get('/api/profile')).body.profile).toEqual({ name: 'Ada', skills: ['Python'] });
    expect((await client.put('/api/profile', [1, 2])).status).toBe(400);
  });
});

describe('jobs → CV → preferences / CSS API', () => {
  it('supports the full lifecycle with cascade delete', async () => {
    const { job } = (await client.post('/api/jobs', { title: 'Engineer', company: 'Acme' })).body;
    expect((await client.get('/api/jobs')).body.jobs).toEqual([expect.objectContaining({ id: job.id, title: 'Engineer' })]);

    expect((await client.put(`/api/jobs/${job.id}`, { description: 'Posting text' })).body.job.description).toBe('Posting text');

    await client.put(`/api/jobs/${job.id}/cv`, { html: '<h1>Ada</h1><script>bad()</script>' });
    expect((await client.get(`/api/jobs/${job.id}/cv`)).body.html).toBe('<h1>Ada</h1>');

    await client.put(`/api/jobs/${job.id}/css`, { css: 'h1 { color: navy }' });
    expect((await client.get(`/api/jobs/${job.id}/css`)).body.css).toBe('h1 { color: navy }');

    const prefs = (await client.get(`/api/jobs/${job.id}/preferences`)).body.preferences;
    await client.put(`/api/jobs/${job.id}/preferences`, { preferences: { ...prefs, maxPages: 1 } });
    expect((await client.get(`/api/jobs/${job.id}/preferences`)).body.preferences.maxPages).toBe(1);

    expect((await client.del(`/api/jobs/${job.id}`)).status).toBe(200);
    expect((await client.get(`/api/jobs/${job.id}/cv`)).status).toBe(404);
    expect((await client.get(`/api/jobs/${job.id}/preferences`)).status).toBe(404);
    expect((await client.del(`/api/jobs/${job.id}`)).status).toBe(404);
  });

  it('serves the CV as a standalone document with a strict CSP', async () => {
    const { job } = (await client.post('/api/jobs', { title: 'Engineer', company: 'Acme' })).body;
    await client.put(`/api/jobs/${job.id}/cv`, { html: '<h1>Ada Lovelace</h1>' });
    await client.put(`/api/jobs/${job.id}/css`, { css: 'h1 { color: navy }' });
    const res = await client.request('GET', `/api/jobs/${job.id}/document`);
    expect(res.headers.get('content-security-policy')).toMatch(/default-src 'none'/);
    const html = await res.text();
    expect(html).toContain('<h1>Ada Lovelace</h1>');
    expect(html).toContain('h1 { color: navy }');
    expect(html).toContain('<title>CV – Engineer – Acme</title>');
  });

  it('validates bodies and ids', async () => {
    const { job } = (await client.post('/api/jobs', { title: 'X' })).body;
    expect((await client.put(`/api/jobs/${job.id}/cv`, { html: 42 })).status).toBe(400);
    expect((await client.put(`/api/jobs/${job.id}/css`, {})).status).toBe(400);
    expect((await client.get('/api/jobs/..%2F..%2Fusers/cv')).status).toBe(400);
  });
});

describe('sessions API', () => {
  it('creates, renames, lists and deletes chat sessions', async () => {
    const { session } = (await client.post('/api/sessions')).body;
    expect(session.title).toBe('New conversation');
    await client.json('PATCH', `/api/sessions/${session.id}`, { title: 'Acme application' });
    expect((await client.get('/api/sessions')).body.sessions).toEqual([expect.objectContaining({ id: session.id, title: 'Acme application' })]);
    expect((await client.get(`/api/sessions/${session.id}`)).body).toMatchObject({ running: false, session: { messages: [], events: [] } });
    expect((await client.del(`/api/sessions/${session.id}`)).status).toBe(200);
    expect((await client.get(`/api/sessions/${session.id}`)).status).toBe(404);
  });
});

describe('system API', () => {
  it('reports each agent’s model, context window, tools and skills', async () => {
    const { agents } = (await client.get('/api/system')).body;
    expect(agents.map((a: any) => a.agent)).toEqual(['coordinator', 'writer', 'critic']);
    expect(agents[0]).toMatchObject({ model: 'test-coordinator', contextWindow: 100_000 });
    expect(agents[0].skills[0].name).toBe('profile-interview');
    expect(agents[1].tools).toContain('editCSS');
    expect(agents[2].tools).not.toContain('editCV');
  });
});
