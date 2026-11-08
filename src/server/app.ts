import path from 'node:path';
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { streamSSE } from 'hono/streaming';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AGENT_NAMES } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { AgentRuntime } from '../agents/runtime.js';
import type { AgentEvent } from '../agents/events.js';
import { toolNames } from '../agents/tools/index.js';
import { ChatService, SessionBusyError, SessionNotFoundError, visibleMessages } from '../chat/service.js';
import type { PdfRenderer } from '../pdf/renderer.js';
import type { SkillLibrary } from '../skills/loader.js';
import { buildCvDocument, sanitizeCvHtml } from '../lib/html.js';
import { countPdfPages } from '../pdf/renderer.js';
import { authRoutes, requireAuth, type AppEnv } from './auth.js';
import { CV_DOCUMENT_CSP, parseBody, requireJsonForMutations, safeFilename, securityHeaders } from './http.js';

export interface AppDeps {
  config: Config;
  repo: Repo;
  runtime: AgentRuntime;
  chat: ChatService;
  skills: SkillLibrary;
  pdf: Pick<PdfRenderer, 'render'>;
}

const jsonObject = z.record(z.string(), z.unknown());

export function createApp(deps: AppDeps) {
  const { config, repo, chat, runtime, skills, pdf } = deps;
  const app = new Hono<AppEnv>();

  app.use('*', securityHeaders());
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    if (err instanceof SessionBusyError) return c.json({ error: err.message }, 409);
    if (err instanceof SessionNotFoundError) return c.json({ error: err.message }, 404);
    console.error('[server]', err);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/api/health', async (c) => {
    await repo.db.query('SELECT 1');
    return c.json({ ok: true, db: repo.db.kind });
  });

  const api = new Hono<AppEnv>();
  api.use('*', requireJsonForMutations());
  api.route('/auth', authRoutes(repo, config));

  // ---------- everything below requires a signed-in user ----------
  const secured = new Hono<AppEnv>();
  secured.use('*', requireAuth(repo));

  secured.get('/system', async (c) => {
    const agents = await Promise.all(
      AGENT_NAMES.map(async (name) => ({
        name,
        model: config.agents[name].model,
        contextWindow: await runtime.contextWindow(name),
        maxSteps: config.agents[name].maxSteps,
        tools: toolNames(name),
        skills: skills.list(name).map((s) => ({ name: s.name, description: s.description, files: s.files })),
      })),
    );
    return c.json({ agents, ollamaHost: config.ollama.host, database: repo.db.kind });
  });

  // Profile (one per user)
  secured.get('/profile', async (c) => c.json({ profile: await repo.getProfile(c.get('user').id) }));
  secured.put('/profile', async (c) => {
    const { profile } = await parseBody(c, z.object({ profile: jsonObject }));
    return c.json({ profile: await repo.saveProfile(c.get('user').id, profile) });
  });

  // Jobs (N per profile) with their CV, preferences and CSS
  secured.get('/jobs', async (c) => c.json({ jobs: await repo.listJobs(c.get('user').id) }));
  secured.post('/jobs', async (c) => {
    const { job } = await parseBody(c, z.object({ job: jsonObject.default({}) }).default({ job: {} }));
    const created = await repo.createJob(c.get('user').id, job);
    return c.json({ job: created }, 201);
  });

  const loadJob = async (userId: string, jobId: string) => {
    const [job, cv] = await Promise.all([repo.getJob(userId, jobId), repo.getCv(userId, jobId)]);
    if (!job || !cv) throw new HTTPException(404, { message: 'Job not found' });
    return { job, cv };
  };

  secured.get('/jobs/:id', async (c) => {
    const { job, cv } = await loadJob(c.get('user').id, c.req.param('id'));
    return c.json({ job, cv });
  });
  secured.put('/jobs/:id', async (c) => {
    const { job } = await parseBody(c, z.object({ job: jsonObject }));
    const saved = await repo.saveJob(c.get('user').id, c.req.param('id'), job);
    if (!saved) throw new HTTPException(404, { message: 'Job not found' });
    return c.json({ job: saved });
  });
  secured.delete('/jobs/:id', async (c) => {
    if (!(await repo.deleteJob(c.get('user').id, c.req.param('id')))) throw new HTTPException(404, { message: 'Job not found' });
    return c.json({ ok: true });
  });
  secured.put('/jobs/:id/cv', async (c) => {
    const { html } = await parseBody(c, z.object({ html: z.string().max(500_000) }));
    if (!(await repo.saveCvHtml(c.get('user').id, c.req.param('id'), sanitizeCvHtml(html)))) {
      throw new HTTPException(404, { message: 'Job not found' });
    }
    return c.json((await loadJob(c.get('user').id, c.req.param('id'))).cv);
  });
  secured.put('/jobs/:id/css', async (c) => {
    const { css } = await parseBody(c, z.object({ css: z.string().max(200_000) }));
    if (/<\/?style|<script/i.test(css)) throw new HTTPException(400, { message: 'CSS must not contain HTML tags' });
    if (!(await repo.saveCss(c.get('user').id, c.req.param('id'), css))) throw new HTTPException(404, { message: 'Job not found' });
    return c.json((await loadJob(c.get('user').id, c.req.param('id'))).cv);
  });
  secured.put('/jobs/:id/preferences', async (c) => {
    const { preferences } = await parseBody(c, z.object({ preferences: jsonObject }));
    if (!(await repo.savePreferences(c.get('user').id, c.req.param('id'), preferences))) {
      throw new HTTPException(404, { message: 'Job not found' });
    }
    return c.json((await loadJob(c.get('user').id, c.req.param('id'))).cv);
  });

  secured.get('/jobs/:id/cv.html', async (c) => {
    const user = c.get('user');
    const { job, cv } = await loadJob(user.id, c.req.param('id'));
    const doc = buildCvDocument(cv.html, cv.css, {
      title: String(job.data.title ?? 'CV'),
      lang: typeof cv.preferences.language === 'string' ? cv.preferences.language : undefined,
    });
    c.header('Content-Security-Policy', CV_DOCUMENT_CSP);
    return c.html(doc);
  });

  secured.get('/jobs/:id/cv.pdf', async (c) => {
    const user = c.get('user');
    const { job, cv } = await loadJob(user.id, c.req.param('id'));
    const profile = await repo.getProfile(user.id);
    const name = safeFilename(['CV', profile.name ?? user.name, job.data.company, job.data.title]);
    const bytes = await pdf.render(cv.html, cv.css, cv.preferences, { title: name });
    const disposition = c.req.query('inline') ? 'inline' : 'attachment';
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${name}.pdf"`,
      'X-Page-Count': String(countPdfPages(bytes)),
      'Cache-Control': 'no-store',
    });
  });

  // Chat sessions (independent of jobs)
  secured.get('/sessions', async (c) => c.json({ sessions: await repo.listChatSessions(c.get('user').id) }));
  secured.post('/sessions', async (c) => {
    const { title } = await parseBody(c, z.object({ title: z.string().trim().min(1).max(120).optional() }).default({}));
    return c.json({ session: await repo.createChatSession(c.get('user').id, title) }, 201);
  });
  secured.get('/sessions/:id', async (c) => {
    const session = await repo.getChatSession(c.get('user').id, c.req.param('id'));
    if (!session) throw new HTTPException(404, { message: 'Chat session not found' });
    return c.json({
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messages: visibleMessages(session.data.messages as never),
        activity: session.data.activity,
        busy: chat.isBusy(session.id),
      },
    });
  });
  secured.patch('/sessions/:id', async (c) => {
    const { title } = await parseBody(c, z.object({ title: z.string().trim().min(1).max(120) }));
    if (!(await repo.saveChatSession(c.get('user').id, c.req.param('id'), { title }))) {
      throw new HTTPException(404, { message: 'Chat session not found' });
    }
    return c.json({ ok: true });
  });
  secured.delete('/sessions/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    if (chat.isBusy(id)) chat.stop(user.id, id);
    if (!(await repo.deleteChatSession(user.id, id))) throw new HTTPException(404, { message: 'Chat session not found' });
    return c.json({ ok: true });
  });

  const streamRun = (c: Context<AppEnv>, userId: string, sessionId: string) =>
    streamSSE(c, async (stream) => {
      let finish!: () => void;
      const finished = new Promise<void>((r) => (finish = r));
      // Writes are chained so events stay ordered and the final "done" is flushed before closing.
      let pendingWrites = Promise.resolve();
      const write = (msg: { data: string; event?: string }) => {
        pendingWrites = pendingWrites.then(() => stream.writeSSE(msg)).catch(() => {});
      };
      const unsubscribe = chat.subscribe(userId, sessionId, (event: AgentEvent) => {
        write({ data: JSON.stringify(event) });
        if (event.type === 'done') finish();
      });
      if (!unsubscribe) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'done', at: new Date().toISOString() }) });
        return;
      }
      const ping = setInterval(() => write({ event: 'ping', data: '' }), 15_000);
      stream.onAbort(() => finish());
      await finished;
      clearInterval(ping);
      unsubscribe();
      await pendingWrites;
    });

  secured.post('/sessions/:id/messages', async (c) => {
    const user = c.get('user');
    const { content, timezone } = await parseBody(
      c,
      z.object({ content: z.string().trim().min(1).max(50_000), timezone: z.string().max(64).optional() }),
    );
    await chat.start(user.id, c.req.param('id'), content, { timezone });
    return streamRun(c, user.id, c.req.param('id'));
  });
  secured.get('/sessions/:id/stream', async (c) => streamRun(c, c.get('user').id, c.req.param('id')));
  secured.post('/sessions/:id/stop', async (c) => c.json({ stopped: chat.stop(c.get('user').id, c.req.param('id')) }));

  api.route('/', secured);
  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  // ---------- static single-page client ----------
  const root = path.relative(process.cwd(), config.publicDir) || '.';
  app.use('/*', serveStatic({ root }));
  app.get('*', serveStatic({ root, path: 'index.html' }));

  return app;
}

export type App = ReturnType<typeof createApp>;
