import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeDeps, tempDir } from '../helpers';
import { TestClient, buildApp } from '../helpers/http';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let app: ReturnType<typeof buildApp>;
beforeEach(async () => {
  tmp = await tempDir();
  app = buildApp(makeDeps(tmp.dir));
});
afterEach(() => tmp.cleanup());

describe('registration and sign-in', () => {
  it('registers, signs out, and signs back in', async () => {
    const client = new TestClient(app);
    const user = await client.register('ada@example.com', 'password123', 'Ada');
    expect(user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(user).not.toHaveProperty('passwordHash');
    expect((await client.get('/api/auth/me')).body.user.id).toBe(user.id);

    await client.post('/api/auth/logout');
    expect(client.cookie).toBe('');
    expect((await client.get('/api/auth/me')).status).toBe(401);

    const login = await client.post('/api/auth/login', { email: 'ADA@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect((await client.get('/api/auth/me')).body.user.id).toBe(user.id);
  });

  it('sets an httpOnly, SameSite cookie', async () => {
    const res = await new TestClient(app).request('POST', '/api/auth/register', { email: 'c@d.co', password: 'password123' });
    expect(res.headers.get('set-cookie')).toMatch(/HttpOnly/);
    expect(res.headers.get('set-cookie')).toMatch(/SameSite=Lax/);
  });

  it('validates input and rejects duplicates and bad passwords', async () => {
    const client = new TestClient(app);
    expect((await client.post('/api/auth/register', { email: 'bad', password: 'password123' })).status).toBe(400);
    expect((await client.post('/api/auth/register', { email: 'a@b.co', password: 'short' })).status).toBe(400);
    expect((await client.json('POST', '/api/auth/register', 'not json')).status).toBe(400);
    await client.register('a@b.co');
    expect((await new TestClient(app).post('/api/auth/register', { email: 'a@b.co', password: 'password123' })).status).toBe(409);
    expect((await new TestClient(app).post('/api/auth/login', { email: 'a@b.co', password: 'wrongpassword' })).status).toBe(401);
    expect((await new TestClient(app).post('/api/auth/login', { email: 'nobody@b.co', password: 'password123' })).status).toBe(401);
  });

  it('protects every data route', async () => {
    const anon = new TestClient(app);
    for (const path of ['/api/profile', '/api/jobs', '/api/sessions', '/api/system', '/api/jobs/x/cv', '/api/jobs/x/cv.pdf']) {
      expect((await anon.get(path)).status, path).toBe(401);
    }
    anon.cookie = 'cvw_session=forged.9999999999.signature';
    expect((await anon.get('/api/profile')).status).toBe(401);
  });
});

describe('multiple accounts', () => {
  it('keeps each user’s profile, jobs, CVs and chats separate', async () => {
    const ada = new TestClient(app);
    const bob = new TestClient(app);
    await ada.register('ada@example.com');
    await bob.register('bob@example.com');

    await ada.put('/api/profile', { profile: { name: 'Ada' } });
    const job = (await ada.post('/api/jobs', { title: 'Engineer' })).body.job;
    const session = (await ada.post('/api/sessions')).body.session;

    expect((await bob.get('/api/profile')).body.profile.name).toBe('');
    expect((await bob.get('/api/jobs')).body.jobs).toEqual([]);
    expect((await bob.get(`/api/jobs/${job.id}`)).status).toBe(404);
    expect((await bob.get(`/api/jobs/${job.id}/cv`)).status).toBe(404);
    expect((await bob.put(`/api/jobs/${job.id}/css`, { css: 'x' })).status).toBe(404);
    expect((await bob.get(`/api/sessions/${session.id}`)).status).toBe(404);
    expect((await bob.get('/api/sessions')).body.sessions).toEqual([]);
    expect((await ada.get('/api/profile')).body.profile.name).toBe('Ada');
  });
});
