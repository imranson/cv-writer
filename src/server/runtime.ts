import path from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { ConversationService } from '../agents/conversation.ts';
import type { AgentDeps, AgentModels } from '../agents/deps.ts';
import type { AppConfig } from '../config.ts';
import { PdfRenderer, type PdfService } from '../cv/pdf.ts';
import { OllamaChatModel } from '../llm/ollama.ts';
import { SkillLibrary } from '../skills/library.ts';
import { Store } from '../storage/store.ts';
import { fetchPage, type FetchedPage } from '../util/fetchPage.ts';
import { createApp } from './app.ts';

export function createOllamaModels(config: AppConfig): AgentModels {
  const { ollama } = config;
  const make = (model: string) =>
    new OllamaChatModel({
      host: ollama.host,
      apiKey: ollama.apiKey,
      model,
      think: ollama.think,
      temperature: ollama.temperature,
      contextLength: ollama.contextLength,
    });
  const coordinator = make(ollama.model);
  return {
    coordinator,
    writer: ollama.writerModel === ollama.model ? coordinator : make(ollama.writerModel),
    critic: ollama.criticModel === ollama.model ? coordinator : make(ollama.criticModel),
  };
}

export interface RuntimeOverrides {
  models?: AgentModels;
  pdf?: PdfService | null;
  fetchPage?: (url: string) => Promise<FetchedPage>;
}

export interface Runtime {
  deps: AgentDeps;
  conversation: ConversationService;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

export async function createRuntime(config: AppConfig, overrides: RuntimeOverrides = {}): Promise<Runtime> {
  const store = new Store(config.dataDir);
  await store.init();
  const pdf = overrides.pdf === undefined ? new PdfRenderer({ allowedHosts: config.pdfAllowedHosts }) : (overrides.pdf ?? undefined);
  const deps: AgentDeps = {
    store,
    skills: new SkillLibrary(config.builtinSkillsDir, path.join(config.dataDir, 'skills')),
    models: overrides.models ?? createOllamaModels(config),
    pdf,
    fetchPage: overrides.fetchPage ?? ((url) => fetchPage(url)),
  };
  const conversation = new ConversationService(deps, { compactThreshold: config.compactThreshold });
  const app = createApp({
    deps,
    conversation,
    webDir: config.webDir,
    info: {
      host: config.ollama.host,
      models: { coordinator: config.ollama.model, writer: config.ollama.writerModel, critic: config.ollama.criticModel },
    },
  });
  return { deps, conversation, app, close: async () => pdf?.close() };
}

export function listen(runtime: Runtime, port: number, hostname: string): Promise<ServerType> {
  return new Promise((resolve) => {
    const server = serve({ fetch: runtime.app.fetch, port, hostname }, () => resolve(server));
  });
}
