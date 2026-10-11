import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import { BusyError, ConversationService, type ServerEvent } from '../agents/conversation.ts';
import { checkCv } from '../agents/commonTools.ts';
import { pageCountFor, runCritic } from '../agents/critic.ts';
import type { AgentDeps } from '../agents/deps.ts';
import { buildCvDocument } from '../cv/document.ts';
import { STYLE_PRESETS } from '../cv/styles.ts';
import { AUDIENCES, SkillError } from '../skills/library.ts';
import { NotFoundError } from '../storage/store.ts';
import { InvalidIdError } from '../util/ids.ts';

export interface AppOptions {
  deps: AgentDeps;
  conversation: ConversationService;
  /** Directory of the built frontend; omitted in API-only tests. */
  webDir?: string;
  info?: { host: string; models: { coordinator: string; writer: string; critic: string } };
}

class BadRequestError extends Error {}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new BadRequestError('Request body must be JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  return parsed.data;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

/** Restrictive CSP for rendered CVs: styles and fonts only, no scripts. */
const CV_CSP = "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com data:; img-src data:";

export function pdfFileName(profile: string, company: string): string {
  const name = profile.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? '';
  const clean = (s: string) => s.replace(/[^\p{L}\p{N} .,&'-]+/gu, '').trim();
  return `${[clean(name), clean(company), 'CV'].filter(Boolean).join(' - ')}.pdf`;
}

export function createApp(opts: AppOptions): Hono {
  const { deps, conversation } = opts;
  const { store, skills } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof NotFoundError) return c.json({ error: err.message }, 404);
    if (err instanceof InvalidIdError || err instanceof BadRequestError || err instanceof SkillError) return c.json({ error: err.message }, 400);
    if (err instanceof BusyError) return c.json({ error: err.message }, 409);
    console.error(err);
    return c.json({ error: err instanceof Error ? err.message : 'Internal error' }, 500);
  });

  const api = new Hono();

  api.get('/health', (c) => c.json({ ok: true }));

  api.get('/config', async (c) =>
    c.json({
      models: opts.info?.models ?? { coordinator: deps.models.coordinator.name, writer: deps.models.writer.name, critic: deps.models.critic.name },
      host: opts.info?.host,
      contextLength: await conversation.contextLimit(),
      pdf: Boolean(deps.pdf),
    }),
  );

  // ── Profile ──
  api.get('/profile', async (c) => c.json({ markdown: await store.readProfile() }));
  api.put('/profile', async (c) => {
    const { markdown } = await body(c, z.object({ markdown: z.string() }));
    await store.writeProfile(markdown);
    return c.json({ markdown: await store.readProfile() });
  });

  // ── Jobs ──
  const JobInput = z.object({ title: z.string().min(1), company: z.string().min(1), listing: z.string(), url: z.string().optional() });
  api.get('/jobs', async (c) => c.json(await store.listJobs()));
  api.post('/jobs', async (c) => c.json(await store.createJob(await body(c, JobInput)), 201));
  api.get('/jobs/:id', async (c) => c.json(await store.requireJob(c.req.param('id'))));
  api.put('/jobs/:id', async (c) => c.json(await store.updateJob(c.req.param('id'), await body(c, JobInput.partial()))));
  api.delete('/jobs/:id', async (c) => {
    await store.deleteJob(c.req.param('id'));
    return c.body(null, 204);
  });

  // ── CV, versions, style ──
  api.get('/jobs/:id/cv', async (c) => {
    const id = c.req.param('id');
    await store.requireJob(id);
    return c.json({ html: (await store.readCv(id)) ?? '' });
  });
  api.put('/jobs/:id/cv', async (c) => {
    const { html } = await body(c, z.object({ html: z.string() }));
    return c.json({ html: await store.writeCv(c.req.param('id'), html, 'user') });
  });
  api.get('/jobs/:id/cv/versions', async (c) => {
    const id = c.req.param('id');
    await store.requireJob(id);
    return c.json(await store.listCvVersions(id));
  });
  api.get('/jobs/:id/cv/versions/:vid', async (c) => {
    const html = await store.readCvVersion(c.req.param('id'), c.req.param('vid'));
    if (html === null) throw new NotFoundError('Version not found');
    return c.json({ html });
  });
  api.post('/jobs/:id/cv/versions/:vid/restore', async (c) =>
    c.json({ html: await store.restoreCvVersion(c.req.param('id'), c.req.param('vid')) }),
  );
  api.get('/jobs/:id/style', async (c) => {
    const id = c.req.param('id');
    await store.requireJob(id);
    return c.json({ css: await store.readStyle(id) });
  });
  api.put('/jobs/:id/style', async (c) => {
    const { css } = await body(c, z.object({ css: z.string() }));
    await store.writeStyle(c.req.param('id'), css);
    return c.json({ css });
  });
  api.get('/style-presets', (c) => c.json(STYLE_PRESETS));

  api.get('/jobs/:id/preview', async (c) => {
    const id = c.req.param('id');
    const job = await store.requireJob(id);
    const html = (await store.readCv(id)) ?? '';
    const doc = buildCvDocument({ html, css: await store.readStyle(id), title: `${job.title} — ${job.company}`, preview: true });
    c.header('Content-Security-Policy', CV_CSP);
    return c.html(doc);
  });

  api.get('/jobs/:id/pdf', async (c) => {
    if (!deps.pdf) return c.json({ error: 'PDF rendering is not available' }, 503);
    const id = c.req.param('id');
    const job = await store.requireJob(id);
    const html = await store.readCv(id);
    if (!html?.trim()) throw new NotFoundError('This job has no CV yet');
    const { pdf, pageCount } = await deps.pdf.render(buildCvDocument({ html, css: await store.readStyle(id), title: `${job.title} — ${job.company}` }));
    const filename = pdfFileName(await store.readProfile(), job.company);
    const disposition = c.req.query('download') ? 'attachment' : 'inline';
    return c.body(new Uint8Array(pdf), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${disposition}; filename="${filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'X-Page-Count': String(pageCount),
      'Cache-Control': 'no-store',
    });
  });

  // ── Critique & checks ──
  api.get('/jobs/:id/critiques', async (c) => {
    const id = c.req.param('id');
    await store.requireJob(id);
    return c.json(await store.readCritiques(id));
  });
  api.post('/jobs/:id/critique', async (c) => {
    const { focus } = await body(c, z.object({ focus: z.string().optional() }));
    return c.json(await runCritic(deps, { jobId: c.req.param('id'), focus }));
  });
  api.get('/jobs/:id/checks', async (c) => {
    const id = c.req.param('id');
    await store.requireJob(id);
    const pageCount = await pageCountFor(deps, id);
    return c.json({ pageCount: pageCount ?? null, findings: await checkCv(store, id, pageCount) });
  });

  // ── Sessions ──
  api.get('/sessions', async (c) => c.json(await store.listSessions()));
  api.post('/sessions', async (c) => {
    const { jobId } = await body(c, z.object({ jobId: z.string().nullable().optional() }));
    const session = await store.createSession({ jobId, contextLimit: await conversation.contextLimit() });
    return c.json({ ...session, context: await conversation.contextUsage(session) }, 201);
  });
  api.get('/sessions/:id', async (c) => {
    const session = await store.requireSession(c.req.param('id'));
    return c.json({ ...session, context: await conversation.contextUsage(session), running: conversation.isRunning(session.id) });
  });
  api.patch('/sessions/:id', async (c) => {
    const patch = await body(c, z.object({ title: z.string().min(1).optional(), jobId: z.string().nullable().optional() }));
    const session = await store.requireSession(c.req.param('id'));
    if (patch.jobId) await store.requireJob(patch.jobId);
    const saved = await store.saveSession({
      ...session,
      title: patch.title ?? session.title,
      jobId: patch.jobId !== undefined ? patch.jobId : session.jobId,
    });
    return c.json({ ...saved, context: await conversation.contextUsage(saved) });
  });
  api.delete('/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (conversation.isRunning(id)) throw new BusyError();
    await store.deleteSession(id);
    return c.body(null, 204);
  });
  api.post('/sessions/:id/stop', (c) => c.json({ stopped: conversation.stop(c.req.param('id')) }));
  api.post('/sessions/:id/compact', async (c) => {
    const session = await conversation.compact(c.req.param('id'));
    return c.json({ ...session, context: await conversation.contextUsage(session) });
  });

  api.post('/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    const { text } = await body(c, z.object({ text: z.string().trim().min(1) }));
    await store.requireSession(id);
    if (conversation.isRunning(id)) throw new BusyError();
    return streamSSE(c, async (stream) => {
      let chain = Promise.resolve();
      const emit = (event: ServerEvent) => {
        chain = chain.then(() => stream.writeSSE({ event: event.type, data: JSON.stringify(event) })).catch(() => {});
      };
      try {
        await conversation.sendMessage(id, text, emit);
      } catch (err) {
        emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      }
      await chain;
    });
  });

  // ── Skills ──
  const SkillInput = z.object({
    id: z.string().optional(),
    name: z.string().min(1),
    description: z.string().default(''),
    audience: z.array(z.enum(AUDIENCES as [string, ...string[]])).optional(),
    tags: z.array(z.string()).optional(),
    autoload: z.boolean().optional(),
    body: z.string().min(1),
  });
  api.get('/skills', async (c) => c.json(await skills.list()));
  api.get('/skills/:id', async (c) => {
    const skill = await skills.get(c.req.param('id'));
    if (!skill) throw new NotFoundError('Skill not found');
    return c.json(skill);
  });
  api.post('/skills', async (c) => {
    const input = await body(c, SkillInput);
    if (input.id && (await skills.get(input.id))?.source === 'user') throw new BadRequestError(`Skill "${input.id}" already exists`);
    return c.json(await skills.save(input as Parameters<typeof skills.save>[0]), 201);
  });
  api.put('/skills/:id', async (c) => {
    const input = await body(c, SkillInput);
    return c.json(await skills.save({ ...(input as Parameters<typeof skills.save>[0]), id: c.req.param('id') }));
  });
  api.delete('/skills/:id', async (c) => {
    await skills.delete(c.req.param('id'));
    return c.body(null, 204);
  });

  app.route('/api', api);
  app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

  if (opts.webDir) {
    const root = path.resolve(opts.webDir);
    app.get('*', async (c) => {
      const rel = decodeURIComponent(new URL(c.req.url).pathname);
      let file = path.resolve(root, `.${rel}`);
      if (!file.startsWith(root + path.sep) && file !== root) return c.text('Forbidden', 403);
      const info = await stat(file).catch(() => null);
      if (!info?.isFile()) file = path.join(root, 'index.html');
      const data = await readFile(file).catch(() => null);
      if (!data) return c.text('Frontend not built — run `npm run build`.', 404);
      return c.body(new Uint8Array(data), 200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    });
  }
  return app;
}
