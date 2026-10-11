/**
 * Live smoke tests against real Ollama cloud models. Skipped unless LIVE=1.
 * Run with: npm run test:live  (needs a signed-in local daemon or OLLAMA_API_KEY + OLLAMA_HOST=https://ollama.com)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/events.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { loadConfig, loadDotEnv } from '../../src/config.js';
import { OllamaLLM } from '../../src/llm/ollama.js';
import type { ChatMessage } from '../../src/llm/types.js';
import { Workspace } from '../../src/storage/workspace.js';
import { OllamaWebClient } from '../../src/tools/webClient.js';
import { tempDir } from '../support/fixtures.js';

describe.skipIf(!process.env.LIVE)('live Ollama cloud model', () => {
  let tmp: { dir: string; cleanup: () => Promise<void> };
  let runtime: AgentRuntime;
  let workspace: Workspace;

  beforeAll(async () => {
    loadDotEnv();
    tmp = await tempDir();
    const config = { ...loadConfig(), dataDir: tmp.dir };
    workspace = new Workspace(tmp.dir);
    runtime = new AgentRuntime({
      config,
      llm: new OllamaLLM({ host: config.ollamaHost, apiKey: config.ollamaApiKey }),
      workspace,
      web: new OllamaWebClient({ apiKey: config.ollamaApiKey }),
    });
  });
  afterAll(() => tmp?.cleanup());

  it('uses evalMath and knows the current date', async () => {
    const events: AgentEvent[] = [];
    const history: ChatMessage[] = [
      { role: 'user', content: 'Use your evalMath tool to compute 1234 * 5678, then tell me the result and today\'s date (YYYY-MM-DD). One line.' },
    ];
    const result = await runtime.run('coordinator', history, { emit: (e) => events.push(e) });
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'evalMath')).toBe(true);
    expect(result.text.replace(/[,\s]/g, '')).toContain('7006652');
    expect(result.text).toContain(new Date().toISOString().slice(0, 10));
  }, 180_000);

  it('saves a profile from a short introduction', async () => {
    const history: ChatMessage[] = [
      {
        role: 'user',
        content:
          'Hi! I am Grace Hopper, grace@example.com, based in Arlington. I was a Senior Software Engineer at Univac from 2015-03 to present, where I built the first compiler. Please save my profile now; no questions yet.',
      },
    ];
    await runtime.run('coordinator', history, { emit: () => {} });
    const profiles = await workspace.listProfiles();
    expect(profiles.length).toBe(1);
    expect(JSON.stringify(await workspace.getProfile(profiles[0].id))).toContain('Grace Hopper');
  }, 180_000);
});
