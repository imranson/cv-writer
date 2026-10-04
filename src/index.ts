#!/usr/bin/env node
import { Ollama } from 'ollama';
import { startSession } from './app/session.js';
import { TerminalIO } from './app/terminal.js';
import { loadConfig, USAGE } from './config.js';
import { chromePdfRenderer, findChrome } from './cv/export.js';
import { OllamaChatClient } from './llm/ollama.js';
import { CvStore } from './storage/store.js';
import { directFetcher, firstWorking, ollamaWebFetcher } from './web/fetchPage.js';

const formatTokens = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : String(n));

async function main(): Promise<number> {
  const config = loadConfig();
  if (config === 'help') {
    console.log(USAGE);
    return 0;
  }

  const store = new CvStore(config.dataDir);
  const client = new OllamaChatClient({ host: config.host, ...(config.apiKey ? { apiKey: config.apiKey } : {}) });
  const chrome = await findChrome();
  // Ollama's hosted web fetch reads JavaScript-heavy job boards; a plain GET is the fallback.
  const fetchPage = config.apiKey
    ? firstWorking(ollamaWebFetcher(new Ollama({ headers: { Authorization: `Bearer ${config.apiKey}` } })), directFetcher())
    : directFetcher();

  const io = new TerminalIO({
    input: process.stdin,
    output: process.stdout,
    onInterrupt: () => {
      io.status('Stopped. Everything you shared so far has been saved.');
      process.exit(130);
    },
  });
  io.status(`CV Writer · ${config.model} + ${config.writerModel} via ${config.host}`);
  io.status(`Data in ${config.dataDir} · type /quit to leave · paste freely, or wrap long text in """`);

  const summary = await startSession({
    store,
    client,
    io,
    model: config.model,
    writerModel: config.writerModel,
    fetchPage,
    ...(config.think !== undefined ? { think: config.think } : {}),
    ...(config.resume ? { resume: config.resume } : {}),
    ...(chrome ? { pdf: chromePdfRenderer(chrome) } : {}),
  });

  const { usage } = summary;
  io.status(
    `Session ended · ${summary.turns} turns · ${usage.requests} model calls · ${formatTokens(usage.promptTokens)} in / ${formatTokens(usage.outputTokens)} out tokens`,
  );
  io.status(`Continue this conversation later with: npm start -- --resume ${summary.sessionId}`);
  io.close();
  return summary.endedBy === 'error' ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
