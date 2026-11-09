import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { Repo } from '../db/repo.js';
import { SkillRegistry } from '../agents/skills.js';
import { OllamaClient } from '../llm/ollama.js';
import { normalizePageSize, PdfRenderer } from '../pdf/render.js';
import { createApp } from './app.js';
import { ChatService } from './chat-service.js';

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const repo = new Repo(db);
const skills = new SkillRegistry(config.skillsDir);
const llm = new OllamaClient({ host: config.ollamaHost, apiKey: config.ollamaApiKey, fallbackContextWindow: config.contextWindow });
const pdf = new PdfRenderer();
const chat = new ChatService(repo, {
  llm,
  repo,
  skills,
  config,
  web: { apiKey: config.ollamaApiKey || undefined },
  pageCount: async (userId, jobId) => {
    const [cv, css, prefs] = await Promise.all([repo.getCv(userId, jobId), repo.getCss(userId, jobId), repo.getPreferences(userId, jobId)]);
    return (await pdf.render(cv.html, css, { pageSize: normalizePageSize(prefs.pageSize) })).pages;
  },
});

const app = createApp({ config, repo, skills, llm, chat, pdf, dbKind: db.kind });
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`[cv-writer] listening on http://localhost:${info.port} (db: ${db.kind}, ollama: ${config.ollamaHost}, models: ${JSON.stringify(config.models)})`);
});

const cleanup = setInterval(() => void repo.deleteExpiredSessions().catch(() => {}), 6 * 3600_000);
cleanup.unref();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[cv-writer] ${signal} received, shutting down`);
  chat.abortAll();
  server.close();
  await Promise.race([chat.drain(), new Promise((r) => setTimeout(r, 8000))]);
  await pdf.close();
  await db.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
