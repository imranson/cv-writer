import { Hono, type Context } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { secureHeaders } from 'hono/secure-headers';
import { streamSSE } from 'hono/streaming';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Config } from '../config.js';
import { NotFoundError, type Repo } from '../db/repo.js';
import type { SkillRegistry } from '../agents/skills.js';
import { buildCvDocument } from '../lib/html.js';
import type { LlmClient } from '../llm/types.js';
import { normalizePageSize, type PdfRenderer } from '../pdf/render.js';
import type { AgentEvent } from '../shared/events.js';
import { authMiddleware, authRoutes, requireAuth, type AuthEnv } from './auth.js';
import { BusyError, ChatService } from './chat-service.js';

export interface AppDeps {
  config: Pick<Config, 'models' | 'cookieSecure' | 'publicDir' | 'ollamaHost'>;
  repo: Repo;
  skills: SkillRegistry;
  llm: LlmClient;
  chat: ChatService;
  pdf: Pick<PdfRenderer, 'render'>;
  dbKind: string;
}

function isJsonObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function createApp(deps: AppDeps) {
  const { repo, chat } = deps;
  const app = new Hono<AuthEnv>();

  const appHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      frameSrc: ["'self'"],
      connectSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"],
    },
    xFrameOptions: 'SAMEORIGIN',
  });
  // The CV preview is untrusted, agent-written HTML: no scripts, no network except fonts/images.
  const previewHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      styleSrc: ["'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com', 'data:'],
      imgSrc: ['data:', 'https:'],
      frameAncestors: ["'self'"],
    },
    xFrameOptions: 'SAMEORIGIN',
  });
  app.use('*', (c, next) => (c.req.path.endsWith('/cv/preview') ? previewHeaders(c, next) : appHeaders(c, next)));

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof BusyError) return c.json({ error: err.message }, 409);
    console.error('[http]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/api/health', (c) => c.json({ ok: true, db: deps.dbKind }));

  // CSRF defence: state-changing API calls from the browser must carry a custom header, which a
  // cross-site form cannot send (and cross-origin fetch would need a CORS preflight we never allow).
  app.use('/api/*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && !c.req.header('authorization') && c.req.header('x-cvw') !== '1') {
      return c.json({ error: 'Missing X-CVW header' }, 403);
    }
    await next();
  });

  app.use('/api/*', authMiddleware(repo));
  app.route('/api/auth', authRoutes(repo, { cookieSecure: deps.config.cookieSecure }));

  const api = new Hono<AuthEnv>();
  api.use('*', requireAuth);
  const uid = (c: Context<AuthEnv>) => c.get('user')!.id;
  const body = async (c: Context<AuthEnv>) => {
    try {
      return await c.req.json();
    } catch {
      return undefined;
    }
  };

  // ----- system & skills -----
  api.get('/system', async (c) => {
    const models = deps.config.models;
    const windows = Object.fromEntries(
      await Promise.all(Object.entries(models).map(async ([a, m]) => [a, await deps.llm.contextWindow(m)])),
    );
    return c.json({ models, contextWindows: windows, ollamaHost: deps.config.ollamaHost.replace(/\/\/.*@/, '//') });
  });

  api.get('/skills', async (c) => {
    const out: Record<string, { name: string; description: string; files: string[] }[]> = {};
    for (const agent of ['coordinator', 'writer', 'critic'] as const) {
      out[agent] = (await deps.skills.list(agent)).map(({ name, description, files }) => ({ name, description, files }));
    }
    return c.json(out);
  });

  // ----- profile (1:1) -----
  api.get('/profile', async (c) => c.json({ profile: await repo.getProfile(uid(c)) }));
  api.put('/profile', async (c) => {
    const b = await body(c);
    if (!isJsonObject(b?.profile)) return c.json({ error: 'Body must be { "profile": { ... } }' }, 400);
    return c.json({ profile: await repo.saveProfile(uid(c), b.profile) });
  });

  // ----- jobs (1:N) -----
  api.get('/jobs', async (c) => c.json({ jobs: await repo.listJobs(uid(c)) }));
  api.post('/jobs', async (c) => {
    const b = (await body(c)) ?? {};
    if (b.job !== undefined && !isJsonObject(b.job)) return c.json({ error: '"job" must be an object' }, 400);
    return c.json({ job: await repo.createJob(uid(c), b.job ?? {}) }, 201);
  });
  api.get('/jobs/:id', async (c) => c.json({ job: await repo.getJob(uid(c), c.req.param('id')) }));
  api.put('/jobs/:id', async (c) => {
    const b = await body(c);
    if (!isJsonObject(b?.job)) return c.json({ error: 'Body must be { "job": { ... } }' }, 400);
    return c.json({ job: await repo.saveJob(uid(c), c.req.param('id'), b.job) });
  });
  api.delete('/jobs/:id', async (c) => {
    await repo.deleteJob(uid(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ----- CV (1:1 job), CSS (1:1 CV), preferences (1:1 CV) -----
  api.get('/jobs/:id/cv', async (c) => c.json({ cv: await repo.getCv(uid(c), c.req.param('id')) }));
  api.put('/jobs/:id/cv', async (c) => {
    const b = await body(c);
    if (typeof b?.html !== 'string') return c.json({ error: 'Body must be { "html": "..." }' }, 400);
    return c.json({ cv: await repo.saveCvHtml(uid(c), c.req.param('id'), b.html) });
  });
  api.get('/jobs/:id/css', async (c) => c.json({ css: await repo.getCss(uid(c), c.req.param('id')) }));
  api.put('/jobs/:id/css', async (c) => {
    const b = await body(c);
    if (typeof b?.css !== 'string') return c.json({ error: 'Body must be { "css": "..." }' }, 400);
    return c.json({ css: await repo.saveCss(uid(c), c.req.param('id'), b.css) });
  });
  api.get('/jobs/:id/preferences', async (c) =>
    c.json({ preferences: await repo.getPreferences(uid(c), c.req.param('id')) }),
  );
  api.put('/jobs/:id/preferences', async (c) => {
    const b = await body(c);
    if (!isJsonObject(b?.preferences)) return c.json({ error: 'Body must be { "preferences": { ... } }' }, 400);
    return c.json({ preferences: await repo.savePreferences(uid(c), c.req.param('id'), b.preferences) });
  });

  api.get('/jobs/:id/cv/preview', async (c) => {
    const id = c.req.param('id');
    const [cv, css, job] = await Promise.all([repo.getCv(uid(c), id), repo.getCss(uid(c), id), repo.getJob(uid(c), id)]);
    c.header('cache-control', 'no-store');
    return c.html(buildCvDocument(cv.html, css, String(job.data.title || 'CV')));
  });

  api.get('/jobs/:id/cv.pdf', async (c) => {
    const id = c.req.param('id');
    const userId = uid(c);
    const [cv, css, prefs, job, profile] = await Promise.all([
      repo.getCv(userId, id),
      repo.getCss(userId, id),
      repo.getPreferences(userId, id),
      repo.getJob(userId, id),
      repo.getProfile(userId),
    ]);
    if (!cv.html.trim()) return c.json({ error: 'This job has no CV yet' }, 404);
    const { pdf, pages } = await deps.pdf.render(cv.html, css, {
      pageSize: normalizePageSize(prefs.pageSize),
      title: String(job.data.title || 'CV'),
    });
    const name = [profile?.basics?.name, job.data.company, 'CV']
      .filter(Boolean)
      .join(' ')
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/\s+/g, '_');
    return new Response(new Uint8Array(pdf), {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `${c.req.query('download') ? 'attachment' : 'inline'}; filename="${name || 'CV'}.pdf"`,
        'x-page-count': String(pages),
        'cache-control': 'no-store',
      },
    });
  });

  // ----- chat sessions (independent) -----
  api.get('/chats', async (c) => c.json({ chats: await repo.listChats(uid(c)) }));
  api.post('/chats', async (c) => {
    const b = (await body(c)) ?? {};
    const title = typeof b.title === 'string' && b.title.trim() ? b.title.trim().slice(0, 100) : undefined;
    const created = await repo.createChat(uid(c), title);
    return c.json({ chat: summarizeChat(created) }, 201);
  });
  api.get('/chats/:id', async (c) => {
    const record = await repo.getChat(uid(c), c.req.param('id'));
    return c.json({
      chat: { ...summarizeChat(record), turns: record.data.turns ?? [], focusJobId: record.data.focusJobId ?? null },
      live: chat.liveTurn(uid(c), record.id),
      context: estimateChatContext(record.data.messages ?? []),
    });
  });
  api.patch('/chats/:id', async (c) => {
    const b = await body(c);
    if (typeof b?.title !== 'string' || !b.title.trim()) return c.json({ error: 'Body must be { "title": "..." }' }, 400);
    const record = await repo.saveChat(uid(c), c.req.param('id'), { title: b.title.trim().slice(0, 100) });
    return c.json({ chat: summarizeChat(record) });
  });
  api.delete('/chats/:id', async (c) => {
    const id = c.req.param('id');
    if (chat.isBusy(id)) chat.stop(uid(c), id);
    await repo.deleteChat(uid(c), id);
    return c.json({ ok: true });
  });

  /** Send a message: starts a coordinator turn and streams its events as SSE. */
  api.post('/chats/:id/messages', async (c) => {
    const b = await body(c);
    const text = typeof b?.text === 'string' ? b.text.trim() : '';
    if (!text) return c.json({ error: 'Message text is required' }, 400);
    if (text.length > 50_000) return c.json({ error: 'Message is too long' }, 400);
    const chatId = c.req.param('id');
    const pipe = new EventPipe();
    const { subscription } = await chat.start({
      user: c.get('user')!,
      chatId,
      text,
      focusJobId: typeof b.focusJobId === 'string' ? b.focusJobId : null,
      timeZone: typeof b.timeZone === 'string' ? b.timeZone.slice(0, 64) : undefined,
      listener: pipe.push,
    });
    return pipe.toSSE(c, subscription!);
  });

  /** Re-attach to a turn that is still running (e.g. after a page reload). */
  api.get('/chats/:id/stream', async (c) => {
    const chatId = c.req.param('id');
    await repo.getChat(uid(c), chatId);
    const pipe = new EventPipe();
    const subscription = chat.subscribe(uid(c), chatId, pipe.push);
    if (!subscription) return c.json({ error: 'Nothing is running in this chat' }, 404);
    return pipe.toSSE(c, subscription);
  });

  api.post('/chats/:id/stop', async (c) => c.json({ stopped: chat.stop(uid(c), c.req.param('id')) }));

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ----- static SPA -----
  app.use('/*', serveStatic({ root: path.relative(process.cwd(), deps.config.publicDir) || '.' }));
  app.get('*', async (c) => {
    try {
      return c.html(await readFile(path.join(deps.config.publicDir, 'index.html'), 'utf8'));
    } catch {
      return c.text('Client not built. Run `npm run build:client`.', 404);
    }
  });

  return app;
}

/** Buffers agent events from a turn subscription and writes them out as Server-Sent Events. */
class EventPipe {
  private queue: AgentEvent[] = [];
  private wake: (() => void) | null = null;
  private finished = false;

  push = (e: AgentEvent) => {
    this.queue.push(e);
    if (e.type === 'turn_end') this.finished = true;
    this.wake?.();
  };

  private finish = () => {
    this.finished = true;
    this.wake?.();
  };

  toSSE(c: Context, sub: { unsubscribe: () => void; done: Promise<void> }) {
    return streamSSE(c, async (stream) => {
      // The browser going away only detaches the stream; the turn keeps running and is saved.
      stream.onAbort(() => {
        sub.unsubscribe();
        this.finish();
      });
      void sub.done.then(this.finish);
      const heartbeat = setInterval(() => void stream.write(': ping\n\n').catch(() => {}), 15_000);
      try {
        for (;;) {
          while (this.queue.length) {
            await stream.writeSSE({ event: 'message', data: JSON.stringify(this.queue.shift()) });
          }
          if (this.finished || stream.aborted) break;
          await new Promise<void>((r) => (this.wake = r));
          this.wake = null;
        }
      } finally {
        clearInterval(heartbeat);
        sub.unsubscribe();
      }
    });
  }
}

function summarizeChat(r: { id: string; title: string; createdAt: string; updatedAt: string }) {
  return { id: r.id, title: r.title, createdAt: r.createdAt, updatedAt: r.updatedAt };
}

/** Rough size of the stored coordinator transcript (chars ÷ 4), for the idle context meter. */
function estimateChatContext(messages: { content?: string; tool_calls?: unknown }[]) {
  let chars = 0;
  for (const m of messages) chars += (m.content?.length ?? 0) + 16 + (m.tool_calls ? JSON.stringify(m.tool_calls).length : 0);
  return { transcriptTokens: Math.ceil(chars / 4), messages: messages.length };
}
