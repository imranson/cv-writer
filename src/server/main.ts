import { existsSync } from 'node:fs';
import { serve } from '@hono/node-server';
import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { migrate } from '../db/schema.js';
import { createRepo } from '../db/repo.js';
import { createOllamaClient } from '../llm/ollama.js';
import { createWebClient } from '../lib/web.js';
import { SkillLibrary } from '../skills/loader.js';
import { PdfRenderer } from '../pdf/renderer.js';
import { AgentRuntime } from '../agents/runtime.js';
import { ChatService } from '../chat/service.js';
import { createApp } from './app.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const config = loadConfig();
const db = await createDb({ databaseUrl: config.databaseUrl, pgliteDir: config.pgliteDir });
const applied = await migrate(db);
if (applied.length) console.log(`[db] applied migrations: ${applied.join(', ')}`);

const repo = createRepo(db);
const skills = await SkillLibrary.load(config.skillsDir);
for (const w of skills.warnings) console.warn(`[skills] skipped ${w}`);

const llm = createOllamaClient({ host: config.ollama.host, apiKey: config.ollama.apiKey });
const web = createWebClient({ host: config.ollama.host, apiKey: config.ollama.apiKey });
const pdf = new PdfRenderer();
const runtime = new AgentRuntime({ config, repo, llm, web, skills, pages: pdf });
const chat = new ChatService(repo, runtime);
const app = createApp({ config, repo, runtime, chat, skills, pdf });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`CV Writer listening on http://localhost:${info.port}`);
  console.log(`  database: ${db.kind === 'postgres' ? 'PostgreSQL (DATABASE_URL)' : `PGlite at ${config.pgliteDir}`}`);
  console.log(`  ollama:   ${config.ollama.host}${config.ollama.apiKey ? ' (API key set)' : ''}`);
  for (const [name, a] of Object.entries(config.agents)) console.log(`  ${name.padEnd(11)} ${a.model}`);
});

const purge = setInterval(() => void repo.purgeExpiredSessions().catch(() => {}), 6 * 3600_000);
purge.unref();

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`\n${signal} received, shutting down…`);
  server.close();
  await chat.shutdown().catch(() => {});
  await pdf.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
