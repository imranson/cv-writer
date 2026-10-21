import { createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { readText, writeFileAtomic } from './store/fs';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'cvw_session';
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(expected, actual);
}

/** Stateless signed token: `<userId>.<expiresAtSeconds>.<hmac>`. */
export function signToken(userId: string, secret: string, ttlSeconds = SESSION_TTL_SECONDS, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + ttlSeconds;
  const payload = `${userId}.${exp}`;
  return `${payload}.${hmac(payload, secret)}`;
}

export function verifyToken(token: string | undefined, secret: string, nowMs = Date.now()): string | undefined {
  if (!token) return undefined;
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [userId, exp, sig] = parts;
  const expected = Buffer.from(hmac(`${userId}.${exp}`, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  if (Number(exp) * 1000 < nowMs) return undefined;
  return userId;
}

function hmac(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/** Uses SESSION_SECRET if set, otherwise a random secret persisted in the data dir. */
export async function loadOrCreateSecret(dataDir: string, configured?: string): Promise<string> {
  if (configured) return configured;
  const file = path.join(dataDir, '.session-secret');
  const existing = (await readText(file))?.trim();
  if (existing) return existing;
  const secret = randomBytes(32).toString('base64url');
  await writeFileAtomic(file, secret);
  return secret;
}

export function validateCredentials(input: { email?: unknown; password?: unknown }): string | undefined {
  if (typeof input.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
    return 'A valid email is required';
  }
  if (typeof input.password !== 'string' || input.password.length < 8) {
    return 'Password must be at least 8 characters';
  }
  return undefined;
}
