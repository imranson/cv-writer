import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, TestClient, type TestEnv } from '../helpers/env.js';

let env: TestEnv;
beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(() => env.close());

describe('registration and sign-in', () => {
  it('registers, signs in and out', async () => {
    const c = new TestClient(env.app);
    const reg = await c.register('reg@example.com', 'password123', 'Reg');
    expect(reg.status).toBe(201);
    expect(reg.body.user).toMatchObject({ email: 'reg@example.com', name: 'Reg' });
    expect(reg.body.user).not.toHaveProperty('passwordHash');
    expect(c.cookie).toMatch(/^cvw_sessions=/);

    const me = await c.json('GET', '/api/auth/me');
    expect(me.body.user.email).toBe('reg@example.com');
    expect(me.body.accounts).toHaveLength(1);

    const out = await c.json('POST', '/api/auth/logout', {});
    expect(out.body).toEqual({ user: null, accounts: [] });
    expect((await c.json('GET', '/api/profile')).status).toBe(401);

    const login = await c.json('POST', '/api/auth/login', { email: 'REG@example.com', password: 'password123' });
    expect(login.status).toBe(200);
    expect((await c.json('GET', '/api/profile')).body.profile).toEqual({ name: 'Reg' });
  });

  it('validates input and rejects duplicates and wrong passwords', async () => {
    const c = new TestClient(env.app);
    expect((await c.register('bad-email', 'password123')).status).toBe(400);
    expect((await c.register('short@example.com', 'short')).body.error).toMatch(/8 characters/);
    await c.register('dup@example.com');
    expect((await new TestClient(env.app).register('dup@example.com')).status).toBe(409);
    const wrong = await new TestClient(env.app).json('POST', '/api/auth/login', { email: 'dup@example.com', password: 'nope-nope' });
    expect(wrong).toEqual({ status: 401, body: { error: 'Incorrect email or password' } });
    const unknown = await new TestClient(env.app).json('POST', '/api/auth/login', { email: 'ghost@example.com', password: 'whatever1' });
    expect(unknown.status).toBe(401);
  });

  it('rate-limits repeated failed logins per email', async () => {
    const c = new TestClient(env.app);
    await c.register('limited@example.com');
    const attacker = new TestClient(env.app);
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await attacker.json('POST', '/api/auth/login', { email: 'limited@example.com', password: `wrong-${i}xx` })).status;
    expect(last).toBe(429);
  });

  it('protects every data route', async () => {
    const anon = new TestClient(env.app);
    for (const path of ['/api/profile', '/api/jobs', '/api/sessions', '/api/system']) {
      expect((await anon.json('GET', path)).status).toBe(401);
    }
    expect((await anon.json('GET', '/api/auth/me')).body).toMatchObject({ user: null, accounts: [] });
  });

  it('requires JSON for state-changing requests (CSRF defence)', async () => {
    const res = await new TestClient(env.app).req('POST', '/api/auth/login', 'email=a&password=b', { 'content-type': 'application/x-www-form-urlencoded' });
    expect(res.status).toBe(415);
  });

  it('can disable registration', async () => {
    const closed = await createTestEnv({ env: { ALLOW_REGISTRATION: 'false' } });
    expect((await new TestClient(closed.app).register('x@example.com')).status).toBe(403);
    await closed.close();
  });
});

describe('multiple signed-in accounts', () => {
  it('signs in to several accounts in one browser and switches between them', async () => {
    const browser = new TestClient(env.app);
    await browser.register('first@example.com', 'password123', 'First');
    await browser.json('PUT', '/api/profile', { profile: { name: 'First', secret: 'first-only' } });
    await browser.register('second@example.com', 'password123', 'Second');

    let me = await browser.json('GET', '/api/auth/me');
    expect(me.body.user.email).toBe('second@example.com');
    expect(me.body.accounts.map((a: any) => [a.email, a.active])).toEqual([
      ['second@example.com', true],
      ['first@example.com', false],
    ]);
    expect((await browser.json('GET', '/api/profile')).body.profile).toEqual({ name: 'Second' });

    const firstId = me.body.accounts[1].id;
    expect((await browser.json('POST', '/api/auth/switch', { userId: firstId })).status).toBe(200);
    expect((await browser.json('GET', '/api/profile')).body.profile).toEqual({ name: 'First', secret: 'first-only' });
    expect((await browser.json('POST', '/api/auth/switch', { userId: '00000000-0000-0000-0000-000000000000' })).status).toBe(404);

    // Signing in again to an already signed-in account does not duplicate it.
    await browser.json('POST', '/api/auth/login', { email: 'second@example.com', password: 'password123' });
    me = await browser.json('GET', '/api/auth/me');
    expect(me.body.accounts.map((a: any) => a.email)).toEqual(['second@example.com', 'first@example.com']);

    // Signing out of the active account falls back to the other one.
    const out = await browser.json('POST', '/api/auth/logout', {});
    expect(out.body.user.email).toBe('first@example.com');
    expect((await browser.json('GET', '/api/profile')).body.profile.secret).toBe('first-only');

    await browser.json('POST', '/api/auth/register', { email: 'third@example.com', password: 'password123' });
    const all = await browser.json('POST', '/api/auth/logout', { all: true });
    expect(all.body).toEqual({ user: null, accounts: [] });
    expect(browser.cookie).toBe('');
  });
});
