import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, newSessionToken, validatePassword, verifyPassword } from '../../src/auth/password.js';

describe('password hashing and session tokens', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).not.toBe(b);
    expect(a.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong horse', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });

  it('creates unguessable tokens and stores only hashes', () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(t);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).not.toContain(t);
  });

  it('validates password length', () => {
    expect(validatePassword('short')).toMatch(/8 characters/);
    expect(validatePassword('long enough')).toBeNull();
  });
});
