import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, loadOrCreateSecret, signToken, validateCredentials, verifyPassword, verifyToken } from '../../src/auth';
import { tempDir } from '../helpers';

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('correct horse');
    expect(hash).toMatch(/^scrypt\$/);
    expect(await verifyPassword('correct horse', hash)).toBe(true);
    expect(await verifyPassword('wrong horse', hash)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
  it('salts every hash', async () => {
    expect(await hashPassword('same-password')).not.toBe(await hashPassword('same-password'));
  });
});

describe('session tokens', () => {
  const secret = 'test-secret';
  it('round-trips a user id', () => {
    expect(verifyToken(signToken('user1', secret), secret)).toBe('user1');
  });
  it('rejects tampering, wrong secrets and garbage', () => {
    const token = signToken('user1', secret);
    expect(verifyToken(token.replace('user1', 'user2'), secret)).toBeUndefined();
    expect(verifyToken(token, 'other-secret')).toBeUndefined();
    expect(verifyToken('a.b', secret)).toBeUndefined();
    expect(verifyToken(undefined, secret)).toBeUndefined();
  });
  it('expires', () => {
    const token = signToken('user1', secret, 60, Date.now());
    expect(verifyToken(token, secret, Date.now() + 61_000)).toBeUndefined();
  });
});

describe('validateCredentials', () => {
  it('requires a valid email and an 8+ character password', () => {
    expect(validateCredentials({ email: 'bad', password: 'longenough' })).toMatch(/email/);
    expect(validateCredentials({ email: 'a@b.co', password: 'short' })).toMatch(/8 characters/);
    expect(validateCredentials({ email: 'a@b.co', password: 'longenough' })).toBeUndefined();
  });
});

describe('loadOrCreateSecret', () => {
  let tmp: Awaited<ReturnType<typeof tempDir>>;
  beforeEach(async () => (tmp = await tempDir()));
  afterEach(() => tmp.cleanup());

  it('prefers the configured secret', async () => {
    expect(await loadOrCreateSecret(tmp.dir, 'configured')).toBe('configured');
  });
  it('persists a generated secret', async () => {
    const first = await loadOrCreateSecret(tmp.dir);
    expect(first.length).toBeGreaterThan(20);
    expect(await loadOrCreateSecret(tmp.dir)).toBe(first);
  });
});
