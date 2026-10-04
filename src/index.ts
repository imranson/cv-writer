#!/usr/bin/env node
import { query } from '@anthropic-ai/claude-agent-sdk';
import { buildAgentOptions } from './agents/options.js';
import { createCvTools } from './agents/tools.js';
import { loadConfig, USAGE } from './config.js';
import { chromePdfRenderer, findChrome } from './cv/export.js';
import { NEW_SESSION_KICKOFF, RESUME_KICKOFF, runConversation } from './app/session.js';
import { TerminalIO } from './app/terminal.js';
import { CvStore } from './storage/store.js';

async function main(): Promise<number> {
  const config = loadConfig();
  if (config === 'help') {
    console.log(USAGE);
    return 0;
  }

  const store = new CvStore(config.dataDir);
  const chrome = await findChrome();
  const tools = createCvTools(store, chrome ? { pdf: chromePdfRenderer(chrome) } : {});
  const options = buildAgentOptions({ config, store, tools });

  const io = new TerminalIO({
    input: process.stdin,
    output: process.stdout,
    onInterrupt: () => {
      io.status('Stopped. Everything you shared so far has been saved.');
      process.exit(130);
    },
  });
  io.status(`CV Writer · data in ${config.dataDir} · type /quit to leave · paste freely, or wrap long text in """`);

  const summary = await runConversation({
    io,
    query,
    options,
    kickoff: config.resume ? RESUME_KICKOFF : NEW_SESSION_KICKOFF,
  });
  io.status(`Session ended · ${summary.turns} turns · ~$${summary.costUsd.toFixed(2)}`);
  if (summary.sessionId) io.status(`Continue this conversation later with: npm start -- --resume ${summary.sessionId}`);
  io.close();
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
