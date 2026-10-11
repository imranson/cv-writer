import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { SessionBusyError, SessionNotFoundError, type ChatEvent, type ChatService } from '../chat/service.js';
import type { PdfRenderer } from '../cv/pdf.js';
import { CV_CONTENT_SECURITY_POLICY, renderCvDocument } from '../cv/render.js';
import { isValidId } from '../lib/ids.js';
import { jobTitle, type Workspace } from '../storage/workspace.js';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public');

export interface AppDeps {
  workspace: Workspace;
  chat: ChatService;
  pdf: PdfRenderer;
  clientBundle: () => Promise<string>;
  status: () => Promise<Record<string, unknown>>;
}

function badId(c: Context) {
  return c.json({ error: 'Invalid id' }, 400);
}

export function createApp(deps: AppDeps): Hono {
  const { workspace, chat, pdf } = deps;
  const app = new Hono();

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: err.message }, 500);
  });

  // ---- static client ----
  const sendPublic = (file: string, type: string) => async (c: Context) =>
    c.body(await readFile(path.join(PUBLIC_DIR, file), 'utf8'), 200, { 'Content-Type': type });
  app.get('/', sendPublic('index.html', 'text/html; charset=utf-8'));
  app.get('/app.css', sendPublic('app.css', 'text/css; charset=utf-8'));
  app.get('/app.js', async (c) => c.body(await deps.clientBundle(), 200, { 'Content-Type': 'text/javascript; charset=utf-8' }));

  app.get('/api/status', async (c) => c.json(await deps.status()));

  // ---- chat sessions ----
  app.get('/api/sessions', async (c) => c.json(await chat.list()));
  app.post('/api/sessions', async (c) => c.json(await chat.create(), 201));
  app.get('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    const session = await chat.get(id);
    return session ? c.json({ ...session, running: chat.isRunning(id) }) : c.json({ error: 'Not found' }, 404);
  });
  app.delete('/api/sessions/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    return (await chat.delete(id)) ? c.body(null, 204) : c.json({ error: 'Not found' }, 404);
  });
  app.post('/api/sessions/:id/stop', (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    return c.json({ stopped: chat.stop(id) });
  });
  app.post('/api/sessions/:id/messages', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    const body = await c.req.json().catch(() => ({}));
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) return c.json({ error: 'Message text is required' }, 400);
    if (!(await chat.get(id))) return c.json({ error: 'Not found' }, 404);
    if (chat.isRunning(id)) return c.json({ error: 'This chat is already working on a reply' }, 409);

    return streamSSE(c, async (stream) => {
      // The run continues (and persists) even if the browser disconnects.
      let open = true;
      stream.onAbort(() => {
        open = false;
      });
      const queue: Promise<unknown>[] = [];
      const emit = (event: ChatEvent) => {
        if (open) queue.push(stream.writeSSE({ data: JSON.stringify(event) }).catch(() => (open = false)));
      };
      try {
        await chat.send(id, text, emit);
      } catch (err) {
        const status = err instanceof SessionBusyError ? 'busy' : err instanceof SessionNotFoundError ? 'not found' : 'failed';
        emit({ type: 'error', message: `${status}: ${(err as Error).message}` });
      }
      await Promise.all(queue);
    });
  });

  // ---- profiles & jobs (read-only for the UI; the coordinator writes them) ----
  app.get('/api/profiles', async (c) => c.json(await workspace.listProfiles()));
  app.get('/api/profiles/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    const profile = await workspace.getProfile(id);
    return profile ? c.json(profile) : c.json({ error: 'Not found' }, 404);
  });
  app.get('/api/jobs', async (c) => c.json(await workspace.listJobs(c.req.query('profileId') || undefined)));
  app.get('/api/jobs/:id', async (c) => {
    const id = c.req.param('id');
    if (!isValidId(id)) return badId(c);
    const job = await workspace.getJob(id);
    return job ? c.json(job) : c.json({ error: 'Not found' }, 404);
  });

  // ---- CVs ----
  app.get('/api/cvs', async (c) => c.json(await workspace.listCvs()));
  app.get('/api/cvs/:jobId', async (c) => {
    const jobId = c.req.param('jobId');
    if (!isValidId(jobId)) return badId(c);
    return c.json(await workspace.getCv(jobId));
  });

  const cvDocument = async (jobId: string) => {
    const cv = await workspace.getCv(jobId);
    if (!cv.exists) return undefined;
    const job = await workspace.getJob(jobId);
    return { cv, html: renderCvDocument(cv.html, cv.css, job ? `CV – ${jobTitle(job)}` : 'CV') };
  };

  app.get('/api/cvs/:jobId/document', async (c) => {
    const jobId = c.req.param('jobId');
    if (!isValidId(jobId)) return badId(c);
    const doc = await cvDocument(jobId);
    if (!doc) return c.json({ error: 'No CV for this job yet' }, 404);
    return c.body(doc.html, 200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Security-Policy': CV_CONTENT_SECURITY_POLICY,
      'Cache-Control': 'no-store',
    });
  });

  app.get('/api/cvs/:jobId/pdf', async (c) => {
    const jobId = c.req.param('jobId');
    if (!isValidId(jobId)) return badId(c);
    const doc = await cvDocument(jobId);
    if (!doc) return c.json({ error: 'No CV for this job yet' }, 404);
    const pageSize = doc.cv.preferences.pageSize;
    const bytes = await pdf.render(doc.html, { format: typeof pageSize === 'string' ? pageSize : undefined });
    return c.body(new Uint8Array(bytes), 200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `${c.req.query('download') ? 'attachment' : 'inline'}; filename="cv-${jobId}.pdf"`,
      'Cache-Control': 'no-store',
    });
  });

  app.put('/api/cvs/:jobId/css', async (c) => {
    const jobId = c.req.param('jobId');
    if (!isValidId(jobId)) return badId(c);
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.css !== 'string') return c.json({ error: '"css" (string) is required' }, 400);
    await workspace.saveCv(jobId, { css: body.css });
    return c.json(await workspace.getCv(jobId));
  });

  return app;
}
