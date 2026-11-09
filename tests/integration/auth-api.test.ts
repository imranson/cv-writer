import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth/crypto.js';
import { createTestApp, register, TestClient } from '../helpers.js';

let ctx: Awaited<ReturnType<typeof createTestApp>>;
beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(() => ctx.db.close());

describe('registration & sign-in', () => {
  it('registers, sets httpOnly cookies and reports the user', async () => {
    const c = new TestClient(ctx.app);
    const res = await c.request('POST', '/api/auth/register', { email: 'ada@example.com', name: 'Ada', password: 'password123' });
    expect(res.status).toBe(200);
    const cookies = res.headers.getSetCookie().join('\n');
    expect(cookies).toMatch(/cvw_tokens=[^;]+;.*HttpOnly/i);
    expect(cookies).toMatch(/SameSite=Lax/i);
    const me = await c.json('GET', '/api/auth/me');
    expect(me.body.user).toMatchObject({ email: 'ada@example.com', name: 'Ada' });
    expect(me.body.user.passwordHash).toBeUndefined();
  });

  it('validates input and rejects duplicates', async () => {
    const c = new TestClient(ctx.app);
    expect((await c.json('POST', '/api/auth/register', { email: 'bad', name: 'x', password: 'password123' })).status).toBe(400);
    expect((await c.json('POST', '/api/auth/register', { email: 'x@example.com', name: 'x', password: 'short' })).body.error).toMatch(/8 characters/);
    expect((await c.json('POST', '/api/auth/register', { email: 'x@example.com', name: '', password: 'password123' })).status).toBe(400);
    expect((await c.json('POST', '/api/auth/register', { email: 'ADA@example.com', name: 'A', password: 'password123' })).status).toBe(409);
  });

  it('logs in with correct credentials only', async () => {
    const c = new TestClient(ctx.app);
    expect((await c.json('POST', '/api/auth/login', { email: 'ada@example.com', password: 'wrongpass1' })).status).toBe(401);
    expect((await c.json('POST', '/api/auth/login', { email: 'nobody@example.com', password: 'password123' })).status).toBe(401);
    const ok = await c.json('POST', '/api/auth/login', { email: 'Ada@Example.com', password: 'password123' });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toBeUndefined();
    expect((await c.json('GET', '/api/profile')).status).toBe(200);
  });

  it('rate-limits repeated failed logins', async () => {
    const c = new TestClient(ctx.app);
    const headers = { 'x-forwarded-for': '203.0.113.9' };
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await c.json('POST', '/api/auth/login', { email: 'ada@example.com', password: 'nope-nope' }, headers)).status;
    expect(last).toBe(429);
  });

  it('protects API routes', async () => {
    const c = new TestClient(ctx.app);
    expect((await c.json('GET', '/api/profile')).status).toBe(401);
    expect((await c.json('GET', '/api/jobs')).status).toBe(401);
    expect((await c.json('GET', '/api/auth/me')).body).toEqual({ user: null, accounts: [] });
  });

  it('requires the CSRF header for cookie-authenticated writes', async () => {
    const c = new TestClient(ctx.app);
    await register(c, 'csrf@example.com');
    const res = await ctx.app.request('/api/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
      body: '{}',
    });
    expect(res.status).toBe(403);
  });
});

describe('multiple accounts in one browser', () => {
  it('keeps several accounts signed in, switches and signs out individually', async () => {
    const c = new TestClient(ctx.app);
    const a = await register(c, 'multi-a@example.com', 'Alpha');
    const b = await register(c, 'multi-b@example.com', 'Beta');
    let me = await c.json('GET', '/api/auth/me');
    expect(me.body.user.id).toBe(b.id);
    expect(me.body.accounts.map((x: any) => x.id).sort()).toEqual([a.id, b.id].sort());

    // Data is per active account.
    await c.json('POST', '/api/jobs', { job: { title: 'Beta job' } });
    expect((await c.json('POST', '/api/auth/switch', { userId: a.id })).status).toBe(200);
    expect((await c.json('GET', '/api/auth/me')).body.user.id).toBe(a.id);
    expect((await c.json('GET', '/api/jobs')).body.jobs).toEqual([]);

    expect((await c.json('POST', '/api/auth/switch', { userId: 'someone-else' })).status).toBe(404);

    // Sign out of the active account only.
    const out = await c.json('POST', '/api/auth/logout', {});
    expect(out.body.user.id).toBe(b.id);
    me = await c.json('GET', '/api/auth/me');
    expect(me.body.accounts.map((x: any) => x.id)).toEqual([b.id]);
    expect((await c.json('GET', '/api/jobs')).body.jobs.map((j: any) => j.title)).toEqual(['Beta job']);

    // Re-login as A, then sign out of all.
    await c.json('POST', '/api/auth/login', { email: 'multi-a@example.com', password: 'password123' });
    expect((await c.json('GET', '/api/auth/me')).body.accounts).toHaveLength(2);
    await c.json('POST', '/api/auth/logout', { all: true });
    expect((await c.json('GET', '/api/auth/me')).body).toEqual({ user: null, accounts: [] });
  });

  it('logging out revokes the session server-side', async () => {
    const c = new TestClient(ctx.app);
    await register(c, 'revoke@example.com');
    const token = c.cookies.get('cvw_tokens')!;
    await c.json('POST', '/api/auth/logout', {});
    expect(await ctx.repo.getSessionUsers([hashToken(token)])).toEqual([]);
    const replay = new TestClient(ctx.app);
    replay.cookies.set('cvw_tokens', token);
    expect((await replay.json('GET', '/api/profile')).status).toBe(401);
  });
});

describe('bearer tokens for API clients', () => {
  it('issues a token on request and accepts it without cookies or CSRF header', async () => {
    const c = new TestClient(ctx.app);
    const res = await c.json('POST', '/api/auth/register', { email: 'api@example.com', name: 'Api', password: 'password123', issueToken: true });
    const token = res.body.token as string;
    expect(token).toMatch(/^[\w-]{43}$/);
    const r = await ctx.app.request('/api/jobs', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ job: { title: 'Via API' } }),
    });
    expect(r.status).toBe(201);
    const bad = await ctx.app.request('/api/jobs', { headers: { authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
  });
});
