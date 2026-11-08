import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { hashPassword, hashToken, newSessionToken, validatePassword, verifyPassword } from '../auth/password.js';
import { DuplicateEmailError, type Repo, type User } from '../db/repo.js';
import type { Config } from '../config.js';
import { parseBody } from './http.js';

export const SESSION_COOKIE = 'cvw_sessions';
/** How many accounts can be signed in at once in one browser. */
export const MAX_ACCOUNTS = 5;

export type AppEnv = { Variables: { user: User } };

export function readTokens(c: Context): string[] {
  const raw = getCookie(c, SESSION_COOKIE) ?? '';
  return raw.split('.').filter((t) => /^[A-Za-z0-9_-]{20,}$/.test(t)).slice(0, MAX_ACCOUNTS);
}

function writeTokens(c: Context, tokens: string[], config: Config) {
  if (tokens.length === 0) {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return;
  }
  setCookie(c, SESSION_COOKIE, tokens.join('.'), {
    path: '/',
    httpOnly: true,
    sameSite: 'Lax',
    secure: config.production,
    maxAge: config.sessionTtlDays * 86400,
  });
}

/** Very small fixed-window limiter for login attempts (per email). */
export class AttemptLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000,
  ) {}
  check(key: string): boolean {
    const nowMs = Date.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt < nowMs) {
      this.hits.set(key, { count: 1, resetAt: nowMs + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.max;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
});

export function requireAuth(repo: Repo): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const [active] = readTokens(c);
    const user = active ? await repo.getUserBySessionHash(hashToken(active)) : null;
    if (!user) throw new HTTPException(401, { message: 'Please sign in' });
    c.set('user', user);
    await next();
  };
}

export function authRoutes(repo: Repo, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const limiter = new AttemptLimiter();

  async function signIn(c: Context, user: User) {
    const token = newSessionToken();
    await repo.createAuthSession(user.id, hashToken(token), new Date(Date.now() + config.sessionTtlDays * 86400_000));
    // Keep other signed-in accounts, drop any older session of this same user, make this one active.
    const others: string[] = [];
    for (const t of readTokens(c)) {
      const u = await repo.getUserBySessionHash(hashToken(t));
      if (u && u.id !== user.id) others.push(t);
    }
    writeTokens(c, [token, ...others].slice(0, MAX_ACCOUNTS), config);
  }

  /** Resolves signed-in accounts for a token list; the first valid token is the active account. */
  async function accounts(tokens: string[]) {
    const list: (User & { active: boolean })[] = [];
    const valid: string[] = [];
    for (const [i, t] of tokens.entries()) {
      const u = await repo.getUserBySessionHash(hashToken(t));
      if (u) {
        list.push({ ...u, active: i === 0 && valid.length === 0 });
        valid.push(t);
      }
    }
    return { list, valid };
  }

  app.post('/register', async (c) => {
    if (!config.allowRegistration) throw new HTTPException(403, { message: 'Registration is disabled' });
    const body = await parseBody(c, credentials.extend({ name: z.string().trim().max(120).optional() }));
    const problem = validatePassword(body.password);
    if (problem) throw new HTTPException(400, { message: problem });
    try {
      const user = await repo.createUser({ email: body.email, name: body.name ?? '', passwordHash: await hashPassword(body.password) });
      await signIn(c, user);
      return c.json({ user }, 201);
    } catch (err) {
      if (err instanceof DuplicateEmailError) throw new HTTPException(409, { message: err.message });
      throw err;
    }
  });

  app.post('/login', async (c) => {
    const body = await parseBody(c, credentials);
    if (!limiter.check(body.email)) throw new HTTPException(429, { message: 'Too many attempts. Try again in a few minutes.' });
    const found = await repo.findUserByEmail(body.email);
    const ok = found ? await verifyPassword(body.password, found.passwordHash) : await hashPassword(body.password).then(() => false);
    if (!found || !ok) throw new HTTPException(401, { message: 'Incorrect email or password' });
    limiter.reset(body.email);
    const { passwordHash: _p, ...user } = found;
    await signIn(c, user);
    return c.json({ user });
  });

  app.post('/logout', async (c) => {
    const body = await parseBody(c, z.object({ all: z.boolean().optional() }).default({}));
    const tokens = readTokens(c);
    const remove = body.all ? tokens : tokens.slice(0, 1);
    for (const t of remove) await repo.deleteAuthSession(hashToken(t));
    const { list, valid } = await accounts(tokens.filter((t) => !remove.includes(t)));
    writeTokens(c, valid, config);
    return c.json({ user: list[0] ?? null, accounts: list });
  });

  app.get('/me', async (c) => {
    const tokens = readTokens(c);
    const { list, valid } = await accounts(tokens);
    if (valid.length !== tokens.length) writeTokens(c, valid, config);
    return c.json({ user: list[0] ?? null, accounts: list, allowRegistration: config.allowRegistration });
  });

  app.post('/switch', async (c) => {
    const { userId } = await parseBody(c, z.object({ userId: z.string() }));
    const { list, valid } = await accounts(readTokens(c));
    const index = list.findIndex((u) => u.id === userId);
    if (index < 0) throw new HTTPException(404, { message: 'That account is not signed in' });
    const reordered = [valid[index], ...valid.filter((_, i) => i !== index)];
    writeTokens(c, reordered, config);
    const user = list[index];
    return c.json({ user: { ...user, active: true } });
  });

  return app;
}

