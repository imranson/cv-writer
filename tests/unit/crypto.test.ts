import { describe, expect, it } from 'vitest';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from '../../src/auth/crypto.js';
import { RateLimiter } from '../../src/server/auth.js';

describe('password hashing', () => {
  it('hashes with a random salt and verifies', async () => {
    const a = await hashPassword('correct horse');
    const b = await hashPassword('correct horse');
    expect(a).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(a).not.toBe(b);
    expect(await verifyPassword('correct horse', a)).toBe(true);
    expect(await verifyPassword('wrong', a)).toBe(false);
    expect(await verifyPassword('x', 'garbage')).toBe(false);
  });
});

describe('session tokens', () => {
  it('are random, url-safe and hashed deterministically', () => {
    const t = newSessionToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(newSessionToken()).not.toBe(t);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('RateLimiter', () => {
  it('allows up to the limit per window, then resets', () => {
    const rl = new RateLimiter(2, 1000);
    expect(rl.hit('k', 0)).toBe(true);
    expect(rl.hit('k', 1)).toBe(true);
    expect(rl.hit('k', 2)).toBe(false);
    expect(rl.hit('other', 2)).toBe(true);
    expect(rl.hit('k', 1001)).toBe(true);
    rl.reset('k');
    expect(rl.hit('k', 1002)).toBe(true);
  });
});
