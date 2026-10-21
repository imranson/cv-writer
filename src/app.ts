import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { AGENT_TOOLS } from './agents/tools';
import type { AgentDeps, StreamEvent } from './agents/types';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  hashPassword,
  signToken,
  validateCredentials,
  verifyPassword,
  verifyToken,
} from './auth';
import { ChatService, NotFoundError, SessionBusyError } from './chat';
import type { AgentName } from './config';
import { DOCUMENT_CSP, buildCvDocument, type PdfRenderer } from './pdf';
import type { CvPreferences, Job, PublicUser, User } from './store';
import { sanitizeHtml } from './util/text';

export interface AppOptions {
  deps: AgentDeps;
  secret: string;
  pdf: PdfRenderer;
  publicDir?: string;
  secureCookies?: boolean;
}

type Env = { Variables: { user: User } };

const AGENTS: AgentName[] = ['coordinator', 'writer', 'critic'];

function publicUser(user: User): PublicUser {
  const { passwordHash: _omit, ...rest } = user;
  return rest;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

async function body(c: Context): Promise<Record<string, unknown>> {
  const data = await c.req.json().catch(() => undefined);
  if (!isObject(data)) throw new HttpError(400, 'Expected a JSON object body');
  return data;
}

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function createApp(opts: AppOptions) {
  const { deps, secret } = opts;
  const { store } = deps;
  const chat = new ChatService(deps);
  const app = new Hono<Env>();

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof NotFoundError || /not found/i.test(err.message)) return c.json({ error: err.message }, 404);
    if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
    if (/^Invalid (job|session|user) id/.test(err.message)) return c.json({ error: err.message }, 400);
    console.error(err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  const startSession = (c: Context, user: User) =>
    setCookie(c, SESSION_COOKIE, signToken(user.id, secret), {
      httpOnly: true,
      sameSite: 'Lax',
      secure: opts.secureCookies ?? false,
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });

  // ---- auth --------------------------------------------------------------

  app.post('/api/auth/register', async (c) => {
    const input = await body(c);
    const problem = validateCredentials(input);
    if (problem) throw new HttpError(400, problem);
    const email = String(input.email);
    if (await store.findUserByEmail(email)) throw new HttpError(409, 'An account with this email already exists');
    const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : email.split('@')[0];
    const user = await store.createUser({ email, name, passwordHash: await hashPassword(String(input.password)) });
    startSession(c, user);
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post('/api/auth/login', async (c) => {
    const input = await body(c);
    const user = typeof input.email === 'string' ? await store.findUserByEmail(input.email) : undefined;
    const ok = user && typeof input.password === 'string' && (await verifyPassword(input.password, user.passwordHash));
    if (!user || !ok) throw new HttpError(401, 'Incorrect email or password');
    startSession(c, user);
    return c.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ ok: true });
  });

  app.use('/api/*', async (c, next) => {
    if (c.req.path.startsWith('/api/auth/') && c.req.path !== '/api/auth/me') return next();
    const userId = verifyToken(getCookie(c, SESSION_COOKIE), secret);
    const user = userId ? await store.getUser(userId).catch(() => undefined) : undefined;
    if (!user) return c.json({ error: 'Not signed in' }, 401);
    c.set('user', user);
    return next();
  });

  app.get('/api/auth/me', (c) => c.json({ user: publicUser(c.get('user')) }));

  // ---- system info ---------------------------------------------------------

  app.get('/api/system', async (c) => {
    const agents = await Promise.all(
      AGENTS.map(async (agent) => ({
        agent,
        model: deps.models[agent],
        contextWindow: await deps.llm.contextWindow(deps.models[agent]),
        tools: AGENT_TOOLS[agent],
        skills: (await deps.skills.list(agent)).map(({ name, description }) => ({ name, description })),
      })),
    );
    return c.json({ now: new Date().toISOString(), agents });
  });

  // ---- profile -------------------------------------------------------------

  app.get('/api/profile', async (c) => c.json({ profile: await store.getProfile(c.get('user').id) }));
  app.put('/api/profile', async (c) => {
    const input = await body(c);
    const profile = isObject(input.profile) ? input.profile : input;
    return c.json({ profile: await store.saveProfile(c.get('user').id, profile) });
  });

  // ---- jobs and their CV / preferences / CSS --------------------------------

  app.get('/api/jobs', async (c) => c.json({ jobs: await store.listJobs(c.get('user').id) }));
  app.post('/api/jobs', async (c) => c.json({ job: await store.createJob(c.get('user').id, (await body(c)) as Partial<Job>) }, 201));
  app.get('/api/jobs/:id', async (c) => c.json({ job: await store.requireJob(c.get('user').id, c.req.param('id')) }));
  app.put('/api/jobs/:id', async (c) =>
    c.json({ job: await store.updateJob(c.get('user').id, c.req.param('id'), (await body(c)) as Partial<Job>) }),
  );
  app.delete('/api/jobs/:id', async (c) => {
    const deleted = await store.deleteJob(c.get('user').id, c.req.param('id'));
    if (!deleted) throw new HttpError(404, 'Job not found');
    return c.json({ ok: true });
  });

  app.get('/api/jobs/:id/cv', async (c) => c.json({ html: await store.getCv(c.get('user').id, c.req.param('id')) }));
  app.put('/api/jobs/:id/cv', async (c) => {
    const { html } = await body(c);
    if (typeof html !== 'string') throw new HttpError(400, '`html` must be a string');
    await store.saveCv(c.get('user').id, c.req.param('id'), sanitizeHtml(html));
    return c.json({ ok: true });
  });

  app.get('/api/jobs/:id/css', async (c) => c.json({ css: await store.getCss(c.get('user').id, c.req.param('id')) }));
  app.put('/api/jobs/:id/css', async (c) => {
    const { css } = await body(c);
    if (typeof css !== 'string') throw new HttpError(400, '`css` must be a string');
    await store.saveCss(c.get('user').id, c.req.param('id'), css);
    return c.json({ ok: true });
  });

  app.get('/api/jobs/:id/preferences', async (c) =>
    c.json({ preferences: await store.getPreferences(c.get('user').id, c.req.param('id')) }),
  );
  app.put('/api/jobs/:id/preferences', async (c) => {
    const input = await body(c);
    const prefs = (isObject(input.preferences) ? input.preferences : input) as CvPreferences;
    return c.json({ preferences: await store.savePreferences(c.get('user').id, c.req.param('id'), prefs) });
  });

  const documentFor = async (userId: string, jobId: string) => {
    const [job, html, css, prefs] = await Promise.all([
      store.requireJob(userId, jobId),
      store.getCv(userId, jobId),
      store.getCss(userId, jobId),
      store.getPreferences(userId, jobId),
    ]);
    const title = [job.title, job.company].filter(Boolean).join(' – ');
    return { job, prefs, doc: buildCvDocument(html, css, { title: `CV – ${title}`, lang: prefs.language }) };
  };

  app.get('/api/jobs/:id/document', async (c) => {
    const { doc } = await documentFor(c.get('user').id, c.req.param('id'));
    c.header('Content-Security-Policy', DOCUMENT_CSP);
    c.header('X-Content-Type-Options', 'nosniff');
    return c.html(doc);
  });

  app.get('/api/jobs/:id/cv.pdf', async (c) => {
    const { job, prefs, doc } = await documentFor(c.get('user').id, c.req.param('id'));
    const { pdf, pages } = await opts.pdf.render(doc, prefs);
    const name = `CV-${[job.company, job.title].filter(Boolean).join('-')}`.replace(/[^A-Za-z0-9-]+/g, '-').slice(0, 80);
    const disposition = c.req.query('download') === '1' ? 'attachment' : 'inline';
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${name}.pdf"`,
      'X-Page-Count': String(pages),
    });
  });

  // ---- chat sessions -----------------------------------------------------

  app.get('/api/sessions', async (c) => c.json({ sessions: await store.listSessions(c.get('user').id) }));
  app.post('/api/sessions', async (c) => {
    const input = await c.req.json().catch(() => ({}));
    const title = isObject(input) && typeof input.title === 'string' ? input.title : undefined;
    return c.json({ session: await store.createSession(c.get('user').id, title) }, 201);
  });
  app.get('/api/sessions/:id', async (c) => {
    const session = await store.getSession(c.get('user').id, c.req.param('id'));
    if (!session) throw new HttpError(404, 'Session not found');
    return c.json({ session, running: chat.isRunning(c.get('user').id, session.id) });
  });
  app.patch('/api/sessions/:id', async (c) => {
    const { title } = await body(c);
    const userId = c.get('user').id;
    const session = await store.getSession(userId, c.req.param('id'));
    if (!session) throw new HttpError(404, 'Session not found');
    if (typeof title !== 'string' || !title.trim()) throw new HttpError(400, '`title` is required');
    return c.json({ session: await store.saveSession(userId, { ...session, title: title.trim().slice(0, 120) }) });
  });
  app.delete('/api/sessions/:id', async (c) => {
    const userId = c.get('user').id;
    if (chat.isRunning(userId, c.req.param('id'))) throw new HttpError(409, 'Conversation is busy');
    if (!(await store.deleteSession(userId, c.req.param('id')))) throw new HttpError(404, 'Session not found');
    return c.json({ ok: true });
  });

  /** Runs one coordinator turn and streams every agent event as server-sent events. */
  app.post('/api/sessions/:id/messages', async (c) => {
    const userId = c.get('user').id;
    const sessionId = c.req.param('id');
    const input = await body(c);
    const content = typeof input.content === 'string' ? input.content.trim() : '';
    if (!content) throw new HttpError(400, '`content` is required');
    if (!(await store.getSession(userId, sessionId))) throw new HttpError(404, 'Session not found');
    if (chat.isRunning(userId, sessionId)) throw new HttpError(409, 'This conversation is already running a turn');
    const activeJobId = typeof input.activeJobId === 'string' && input.activeJobId ? input.activeJobId : undefined;

    return streamSSE(c, async (stream) => {
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const send = (event: StreamEvent | { type: 'done'; text: string; title: string }) =>
        stream.writeSSE({ event: event.type, data: JSON.stringify(event) }).catch(() => {});
      try {
        const { session, text } = await chat.sendMessage({
          userId,
          sessionId,
          content,
          activeJobId,
          emit: (e) => void send(e),
          signal: abort.signal,
        });
        await send({ type: 'done', text, title: session.title });
      } catch {
        // The error event was already emitted and persisted by ChatService.
        await send({ type: 'done', text: '', title: '' });
      }
    });
  });

  // ---- static frontend ---------------------------------------------------

  if (opts.publicDir) {
    app.use('/*', serveStatic({ root: opts.publicDir }));
  }

  return app;
}
