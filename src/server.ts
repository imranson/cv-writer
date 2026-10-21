import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadOrCreateSecret } from './auth';
import { loadConfig } from './config';
import { OllamaLLM, OllamaWeb, createOllamaClient } from './llm/ollama';
import { PdfRenderer } from './pdf';
import { SkillLibrary } from './skills';
import { Store } from './store';

const config = loadConfig();
const client = createOllamaClient(config);
const pdf = new PdfRenderer();

const app = createApp({
  deps: {
    store: new Store(config.dataDir),
    llm: new OllamaLLM(client, config.contextWindowOverride),
    web: new OllamaWeb(client, config.ollamaApiKey),
    skills: new SkillLibrary(config.skillsDir),
    models: config.models,
    think: config.think,
  },
  secret: await loadOrCreateSecret(config.dataDir, config.sessionSecret),
  pdf,
  publicDir: config.publicDir,
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`CV Writer running at http://localhost:${info.port}`);
  console.log(`Models: ${Object.entries(config.models).map(([a, m]) => `${a}=${m}`).join(', ')} via ${config.ollamaHost}`);
});

const shutdown = async () => {
  server.close();
  await pdf.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
