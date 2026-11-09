import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { hashPassword, hashToken, newSessionToken, verifyPassword } from '../auth/crypto.js';
import type { Repo, User } from '../db/repo.js';

export const TOKENS_COOKIE = 'cvw_tokens';
export const ACTIVE_COOKIE = 'cvw_active';
const SESSION_DAYS = 30;
const MAX_ACCOUNTS = 5;

export type Account = User & { tokenHash: string };

export type AuthEnv = {
  Variables: {
    user: User | null;
    accounts: Account[];
    /** Raw tokens from the cookie that are still valid, keyed by user id. */
    tokensByUser: Map<string, string>;
    viaBearer: boolean;
  };
};

const credentials = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
});
const registration = credentials.extend({ name: z.string().trim().min(1, 'Name is required').max(100) });

/** Simple fixed-window limiter for login attempts (per IP + email). */
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}
  hit(key: string, now = Date.now()): boolean {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

function readTokens(c: Context): string[] {
  const raw = getCookie(c, TOKENS_COOKIE) ?? '';
  return raw
    .split('.')
    .map((t) => t.trim())
    .filter((t) => /^[A-Za-z0-9_-]{20,100}$/.test(t))
    .slice(0, MAX_ACCOUNTS);
}

function writeCookies(c: Context, tokens: string[], activeUserId: string | null, secure: boolean) {
  const opts = { httpOnly: true, sameSite: 'Lax' as const, secure, path: '/', maxAge: SESSION_DAYS * 86400 };
  if (tokens.length === 0) {
    setCookie(c, TOKENS_COOKIE, '', { ...opts, maxAge: 0 });
    setCookie(c, ACTIVE_COOKIE, '', { ...opts, maxAge: 0 });
    return;
  }
  setCookie(c, TOKENS_COOKIE, tokens.join('.'), opts);
  setCookie(c, ACTIVE_COOKIE, activeUserId ?? '', opts);
}

/**
 * Resolves the signed-in accounts. A browser can hold sessions for several accounts at once (like
 * Google's account switcher); `cvw_active` picks which one requests act as. API clients may send
 * `Authorization: Bearer <token>` instead.
 */
export function authMiddleware(repo: Repo): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const bearer = /^Bearer\s+(\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const tokens = bearer ? [bearer] : readTokens(c);
    const byHash = new Map(tokens.map((t) => [hashToken(t), t]));
    const accounts = await repo.getSessionUsers([...byHash.keys()]);
    const tokensByUser = new Map(accounts.map((a) => [a.id, byHash.get(a.tokenHash)!]));
    const activeId = getCookie(c, ACTIVE_COOKIE);
    c.set('accounts', accounts);
    c.set('tokensByUser', tokensByUser);
    c.set('user', accounts.find((a) => a.id === activeId) ?? accounts[0] ?? null);
    c.set('viaBearer', Boolean(bearer));
    await next();
  };
}

export const requireAuth: MiddlewareHandler<AuthEnv> = async (c, next) => {
  if (!c.get('user')) return c.json({ error: 'Not signed in' }, 401);
  await next();
};

const publicUser = (u: User) => ({ id: u.id, email: u.email, name: u.name });

export function authRoutes(repo: Repo, opts: { cookieSecure: boolean; limiter?: RateLimiter }) {
  const app = new Hono<AuthEnv>();
  const limiter = opts.limiter ?? new RateLimiter(10, 15 * 60_000);

  async function signIn(c: Context<AuthEnv>, user: User, issueToken: boolean) {
    const token = newSessionToken();
    await repo.createSession(user.id, hashToken(token), new Date(Date.now() + SESSION_DAYS * 86400_000));
    // Replace any older session of the same account, keep the other accounts signed in.
    const others = [...c.get('tokensByUser').entries()].filter(([uid]) => uid !== user.id).map(([, t]) => t);
    const tokens = [token, ...others].slice(0, MAX_ACCOUNTS);
    if (!c.get('viaBearer')) writeCookies(c, tokens, user.id, opts.cookieSecure);
    const accounts = [user, ...c.get('accounts').filter((a) => a.id !== user.id)].slice(0, MAX_ACCOUNTS);
    return c.json({ user: publicUser(user), accounts: accounts.map(publicUser), ...(issueToken ? { token } : {}) });
  }

  app.post('/register', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = registration.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.issues[0].message }, 400);
    const { email, password, name } = parsed.data;
    if (await repo.getUserByEmail(email)) return c.json({ error: 'An account with this email already exists' }, 409);
    let user: User;
    try {
      user = await repo.createUser({ email, name, passwordHash: await hashPassword(password) });
    } catch (err) {
      if (/unique|duplicate/i.test(String(err))) return c.json({ error: 'An account with this email already exists' }, 409);
      throw err;
    }
    return signIn(c, user, body?.issueToken === true);
  });

  app.post('/login', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = credentials.safeParse(body);
    if (!parsed.success) return c.json({ error: 'Enter a valid email and password' }, 400);
    const { email, password } = parsed.data;
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
    const key = `${ip}|${email}`;
    if (!limiter.hit(key)) return c.json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
    const found = await repo.getUserByEmail(email);
    // Verify against a dummy hash when the user doesn't exist to keep timing uniform.
    const ok = await verifyPassword(password, found?.passwordHash ?? DUMMY_HASH);
    if (!found || !ok) return c.json({ error: 'Incorrect email or password' }, 401);
    limiter.reset(key);
    const { passwordHash: _ignored, ...user } = found;
    return signIn(c, user, body?.issueToken === true);
  });

  app.post('/logout', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const user = c.get('user');
    const tokensByUser = c.get('tokensByUser');
    const targets = body?.all ? [...tokensByUser.keys()] : user ? [user.id] : [];
    for (const uid of targets) await repo.deleteSession(hashToken(tokensByUser.get(uid)!));
    const remaining = c.get('accounts').filter((a) => !targets.includes(a.id));
    if (!c.get('viaBearer')) {
      writeCookies(c, remaining.map((a) => tokensByUser.get(a.id)!), remaining[0]?.id ?? null, opts.cookieSecure);
    }
    return c.json({ user: remaining[0] ? publicUser(remaining[0]) : null, accounts: remaining.map(publicUser) });
  });

  app.post('/switch', async (c) => {
    const body = await c.req.json().catch(() => null);
    const target = c.get('accounts').find((a) => a.id === body?.userId);
    if (!target) return c.json({ error: 'That account is not signed in on this browser' }, 404);
    writeCookies(c, c.get('accounts').map((a) => c.get('tokensByUser').get(a.id)!), target.id, opts.cookieSecure);
    return c.json({ user: publicUser(target), accounts: c.get('accounts').map(publicUser) });
  });

  app.get('/me', (c) => {
    const user = c.get('user');
    return c.json({ user: user ? publicUser(user) : null, accounts: c.get('accounts').map(publicUser) });
  });

  return app;
}

// scrypt hash of a random throwaway password, used only for timing equalisation.
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$7J2Rk1y3Yq0Cn8wJx3bH3m5m8x8v9tK2hQ0w3f8Zk2A=';
