import { serve } from '@hono/node-server';
import { AgentRuntime } from '../agents/runtime.js';
import { ChatService } from '../chat/service.js';
import { loadConfig, loadDotEnv } from '../config.js';
import { PlaywrightPdfRenderer } from '../cv/pdf.js';
import { OllamaLLM } from '../llm/ollama.js';
import { Workspace } from '../storage/workspace.js';
import { OllamaWebClient } from '../tools/webClient.js';
import { createApp } from './app.js';
import { createClientBundler } from './clientBundle.js';

loadDotEnv();
const config = loadConfig();
const workspace = new Workspace(config.dataDir);
const llm = new OllamaLLM({ host: config.ollamaHost, apiKey: config.ollamaApiKey });
const web = new OllamaWebClient({ apiKey: config.ollamaApiKey });
const runtime = new AgentRuntime({ config, llm, workspace, web });
const pdf = new PlaywrightPdfRenderer();

const app = createApp({
  workspace,
  chat: new ChatService(runtime, workspace),
  pdf,
  clientBundle: createClientBundler({ rebuild: process.env.NODE_ENV !== 'production' }),
  status: async () => ({
    models: config.models,
    ollamaHost: config.ollamaHost,
    contextWindow: await runtime.contextWindow('coordinator'),
    webSearch: web.searchEnabled,
  }),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`CV Writer running at http://localhost:${info.port}`);
  console.log(`Models: ${JSON.stringify(config.models)} via ${config.ollamaHost}; data in ${config.dataDir}`);
  if (!web.searchEnabled) console.log('Web search disabled: set OLLAMA_API_KEY to enable it.');
});

const shutdown = async () => {
  server.close();
  await pdf.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
