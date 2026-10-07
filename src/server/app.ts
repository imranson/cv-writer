import { readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { ZodError } from 'zod';
import type { AgentEvent } from '../agents/agent.js';
import { OPENING_NOTE, runTurn, type AppDeps } from '../agents/coordinator.js';
import { checkCv } from '../cv/checks.js';
import { countPdfPages } from '../cv/pdf.js';
import { renderHtml, renderMarkdown } from '../cv/render.js';
import { FONTS, mergeStyle, STYLE_PRESETS } from '../cv/style.js';
import { profileGaps } from '../domain/profile.js';
import { DEFAULT_STYLE, type CvVersion } from '../domain/schemas.js';
import { NotFoundError } from '../storage/store.js';
import { slugify } from '../util/ids.js';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.md': 'text/markdown; charset=utf-8',
};

export interface ServerOptions extends AppDeps {
  /** Built browser UI (dist/web). */
  staticDir?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(data);
}

async function readBody(req: IncomingMessage, limit = 2_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Body must be JSON');
  }
}

/** Summary of a version for lists: no document body. */
export function versionSummary(cv: CvVersion) {
  const critique = cv.critiques.at(-1);
  return {
    version: cv.version,
    status: cv.status,
    createdAt: cv.createdAt,
    basedOnVersion: cv.basedOnVersion,
    changeSummary: cv.changeSummary,
    feedback: cv.feedback,
    profileRevision: cv.profileRevision,
    writerRunId: cv.writerRunId,
    errors: cv.checks.errorCount,
    warnings: cv.checks.warningCount,
    words: cv.checks.wordCount,
    score: critique?.overallScore,
    verdict: critique?.verdict,
    approvedAt: cv.approvedAt,
    lastExport: cv.exports.at(-1),
  };
}

/** The HTTP API and the browser UI. One conversation turn at a time per session. */
export function createApp(options: ServerOptions): Server {
  const { store } = options;
  const busy = new Set<string>();

  type Handler = (req: IncomingMessage, res: ServerResponse, params: string[], url: URL) => Promise<void>;
  const routes: Array<[string, RegExp, Handler]> = [];
  const route = (method: string, pattern: string, handler: Handler) =>
    routes.push([method, new RegExp(`^${pattern.replace(/:[a-z]+/gi, '([^/]+)')}$`), handler]);

  const version = (v: string | undefined) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid version "${v}"`);
    return n;
  };

  // ---------- read-only views ----------

  route('GET', '/api/config', async (_req, res) => {
    sendJson(res, 200, {
      models: options.models,
      pdfAvailable: Boolean(options.pdf),
      fonts: FONTS,
      presets: STYLE_PRESETS,
      defaultStyle: DEFAULT_STYLE,
      dataDir: store.dataDir,
    });
  });

  route('GET', '/api/profile', async (_req, res) => {
    const profile = await store.getProfile();
    sendJson(res, 200, { profile, gaps: profileGaps(profile) });
  });

  route('GET', '/api/profile/history', async (_req, res) => {
    const history = await store.profileHistory();
    sendJson(res, 200, history.map(({ snapshot: _s, ...rest }) => rest).reverse());
  });

  route('GET', '/api/jobs', async (_req, res) => sendJson(res, 200, await store.listJobs()));
  route('GET', '/api/jobs/:id', async (_req, res, [id]) => sendJson(res, 200, await store.getJob(id!)));

  route('GET', '/api/jobs/:id/cvs', async (_req, res, [id]) => {
    await store.getJob(id!);
    sendJson(res, 200, (await store.listCvVersions(id!)).map(versionSummary));
  });

  route('GET', '/api/jobs/:id/cvs/:v', async (_req, res, [id, v]) => {
    const [cv, profile, job] = await Promise.all([store.getCvVersion(id!, version(v)), store.getProfile(), store.getJob(id!)]);
    // Checks are re-run so the view reflects the profile as it is now.
    sendJson(res, 200, { ...cv, currentChecks: checkCv(cv.document, profile, job) });
  });

  route('GET', '/api/jobs/:id/cvs/:v/html', async (_req, res, [id, v]) => {
    const cv = await store.getCvVersion(id!, version(v));
    res.writeHead(200, { 'Content-Type': MIME['.html']!, 'Cache-Control': 'no-store' });
    res.end(renderHtml(cv.document, await store.getStyle()));
  });

  route('GET', '/api/jobs/:id/cvs/:v/markdown', async (_req, res, [id, v]) => {
    const cv = await store.getCvVersion(id!, version(v));
    res.writeHead(200, {
      'Content-Type': MIME['.md']!,
      'Content-Disposition': `attachment; filename="${slugify(cv.document.name)}-cv-v${cv.version}.md"`,
    });
    res.end(renderMarkdown(cv.document));
  });

  /** A PDF of any version with the saved style, generated on demand (not recorded as an export). */
  route('GET', '/api/jobs/:id/cvs/:v/pdf', async (_req, res, [id, v], url) => {
    if (!options.pdf) throw new HttpError(503, 'PDF export needs Chrome or Chromium (set CHROME_PATH).');
    const cv = await store.getCvVersion(id!, version(v));
    const pdf = await options.pdf(renderHtml(cv.document, await store.getStyle()));
    const name = `${slugify(cv.document.name)}-cv-v${cv.version}.pdf`;
    res.writeHead(200, {
      'Content-Type': MIME['.pdf']!,
      'Content-Disposition': `${url.searchParams.get('download') ? 'attachment' : 'inline'}; filename="${name}"`,
      'X-Page-Count': String(countPdfPages(pdf) ?? ''),
      'Cache-Control': 'no-store',
    });
    res.end(pdf);
  });

  /** Files written by exports (approved PDFs etc.), confined to the output directory. */
  route('GET', '/api/jobs/:id/exports/:file', async (_req, res, [id, file]) => {
    await store.getJob(id!);
    const name = decodeURIComponent(file!);
    if (name !== path.basename(name) || name.startsWith('.')) throw new HttpError(400, 'Invalid file name');
    const full = path.join(store.outputDir(id!), name);
    let data: Buffer;
    try {
      data = await readFile(full);
    } catch {
      throw new HttpError(404, 'No such export');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(name)] ?? 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"` });
    res.end(data);
  });

  route('GET', '/api/style', async (_req, res) => sendJson(res, 200, await store.getStyle()));
  route('PUT', '/api/style', async (req, res) => {
    const body = (await readBody(req)) as Record<string, unknown>;
    let style;
    try {
      style = mergeStyle(await store.getStyle(), body);
    } catch (err) {
      throw err instanceof ZodError ? err : new HttpError(400, (err as Error).message);
    }
    await store.setStyle(style);
    await store.audit({ actor: 'user', action: 'update_style', outcome: 'ok', details: body });
    sendJson(res, 200, style);
  });

  route('GET', '/api/audit', async (_req, res, _p, url) => {
    const limit = Math.min(1000, Number(url.searchParams.get('limit') ?? 200) || 200);
    sendJson(res, 200, (await store.readAudit(limit)).reverse());
  });
  route('GET', '/api/runs/:id', async (_req, res, [id]) => sendJson(res, 200, await store.getRun(id!)));

  // ---------- sessions and conversation ----------

  route('GET', '/api/sessions', async (_req, res) => sendJson(res, 200, await store.listSessions()));
  route('POST', '/api/sessions', async (_req, res) => {
    const latestJob = (await store.listJobs())[0];
    sendJson(res, 201, await store.createSession(latestJob?.id));
  });
  route('GET', '/api/sessions/:id', async (_req, res, [id]) => {
    const s = await store.getSession(id!);
    sendJson(res, 200, { id: s.id, createdAt: s.createdAt, updatedAt: s.updatedAt, activeJobId: s.activeJobId, transcript: s.transcript, busy: busy.has(s.id), usage: s.usage });
  });
  route('PATCH', '/api/sessions/:id', async (req, res, [id]) => {
    const body = (await readBody(req)) as { activeJobId?: unknown };
    if (busy.has(id!)) throw new HttpError(409, 'The coach is busy; try again when it has replied.');
    const session = await store.getSession(id!);
    if (typeof body.activeJobId === 'string') {
      await store.getJob(body.activeJobId);
      session.activeJobId = body.activeJobId;
    }
    const saved = await store.saveSession(session);
    sendJson(res, 200, { id: saved.id, activeJobId: saved.activeJobId });
  });

  const converse = async (res: ServerResponse, sessionId: string, input: { text: string; hidden?: boolean }) => {
    await store.getSession(sessionId);
    if (busy.has(sessionId)) throw new HttpError(409, 'The coach is still working on your last message.');
    busy.add(sessionId);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const send = (event: string, data: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const heartbeat = setInterval(() => send('ping', {}), 15_000);
    try {
      // The turn continues even if the browser goes away, so state stays consistent.
      const { reply } = await runTurn(options, sessionId, input, (e: AgentEvent) => send(e.type, e));
      send('reply', { text: reply });
    } catch (err) {
      send('error', { message: (err as Error).message });
    } finally {
      clearInterval(heartbeat);
      busy.delete(sessionId);
      send('done', {});
      res.end();
    }
  };

  route('POST', '/api/sessions/:id/messages', async (req, res, [id]) => {
    const body = (await readBody(req)) as { text?: unknown };
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text) throw new HttpError(400, 'Message text is required');
    await converse(res, id!, { text });
  });

  /** Lets the coach open a fresh conversation proactively. */
  route('POST', '/api/sessions/:id/open', async (_req, res, [id]) => {
    const session = await store.getSession(id!);
    if (session.transcript.length > 0) {
      sendJson(res, 200, { skipped: true });
      return;
    }
    await converse(res, id!, { text: OPENING_NOTE, hidden: true });
  });

  // ---------- static UI ----------

  const serveStatic = async (res: ServerResponse, url: URL) => {
    if (!options.staticDir) throw new HttpError(404, 'Not found');
    const root = path.resolve(options.staticDir);
    let file = path.resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!file.startsWith(root)) throw new HttpError(403, 'Forbidden');
    const isFile = await stat(file).then((s) => s.isFile(), () => false);
    if (!isFile) file = path.join(root, 'index.html');
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      throw new HttpError(404, 'The UI has not been built. Run `npm run build:web` (npm start does this).');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(data);
  };

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      const method = req.method ?? 'GET';
      // No login: refuse cross-site writes from other pages open in the browser.
      const origin = req.headers.origin;
      if (method !== 'GET' && origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'Cross-origin request refused');
      if (url.pathname.startsWith('/api/')) {
        for (const [m, re, handler] of routes) {
          const match = re.exec(url.pathname);
          if (match && m === method) return await handler(req, res, match.slice(1).map(decodeURIComponent), url);
        }
        throw new HttpError(404, `No route for ${method} ${url.pathname}`);
      }
      if (method !== 'GET') throw new HttpError(405, 'Method not allowed');
      await serveStatic(res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : err instanceof NotFoundError ? 404 : err instanceof ZodError ? 400 : 500;
      const message = err instanceof ZodError ? err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : (err as Error).message;
      if (status === 500) console.error(err);
      if (res.headersSent) {
        if (!res.writableEnded) res.end();
      } else sendJson(res, status, { error: message });
    }
  });
}
