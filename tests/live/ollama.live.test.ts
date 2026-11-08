/**
 * Opt-in checks against a real Ollama endpoint (local daemon signed in, or
 * OLLAMA_HOST=https://ollama.com with OLLAMA_API_KEY). Run with:
 *   LIVE_OLLAMA=1 npx vitest run tests/live
 */
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { createOllamaClient } from '../../src/llm/ollama.js';
import { createWebClient } from '../../src/lib/web.js';
import { runAgent } from '../../src/agents/loop.js';
import { evalMath } from '../../src/agents/tools/common.js';
import type { AgentServices } from '../../src/agents/tool.js';

const live = !!process.env.LIVE_OLLAMA;

describe.skipIf(!live)('live Ollama', () => {
  const config = loadConfig();
  const llm = createOllamaClient({ host: config.ollama.host, apiKey: config.ollama.apiKey });
  const model = config.agents.critic.model;

  it('reports a context window for the configured model', async () => {
    expect(await llm.contextWindow!(model)).toBeGreaterThan(8000);
  });

  it('calls a tool and uses its result', async () => {
    const events: string[] = [];
    const res = await runAgent({
      spec: { agent: 'critic', model, systemPrompt: 'Always use the evalMath tool for arithmetic. Reply with just the number.', tools: [evalMath], maxSteps: 4, contextWindow: 32_000 },
      messages: [{ role: 'user', content: 'What is 1234 * 5678?' }],
      task: 'math',
      userId: 'live',
      services: { llm, now: () => new Date() } as unknown as AgentServices,
      emit: (e) => events.push(e.type === 'tool_start' ? `tool:${e.name}` : e.type),
    });
    expect(res.ok).toBe(true);
    expect(events).toContain('tool:evalMath');
    expect(res.final.replace(/[,\s]/g, '')).toContain('7006652');
  }, 120_000);

  it('searches the web', async () => {
    const web = createWebClient({ host: config.ollama.host, apiKey: config.ollama.apiKey });
    const results = await web.search('Ollama web search API', 2);
    expect(results.length).toBeGreaterThan(0);
  }, 60_000);
});
