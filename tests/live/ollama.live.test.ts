// Runs against the real Ollama endpoint from .env. Opt in with `npm run test:live`.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatService } from '../../src/chat';
import { loadConfig } from '../../src/config';
import { OllamaLLM, OllamaWeb, createOllamaClient } from '../../src/llm/ollama';
import type { StreamEvent } from '../../src/agents/types';
import { makeDeps, tempDir } from '../helpers';

process.loadEnvFile?.('.env');
const config = loadConfig();
const client = createOllamaClient(config);
let tmp: Awaited<ReturnType<typeof tempDir>>;

beforeAll(async () => (tmp = await tempDir()));
afterAll(() => tmp.cleanup());

describe('live Ollama', () => {
  it('reports the model context window', async () => {
    expect(await new OllamaLLM(client, config.contextWindowOverride).contextWindow(config.models.coordinator)).toBeGreaterThan(8000);
  });

  it('coordinator saves a profile fact with editProfile and answers', async () => {
    const deps = makeDeps(tmp.dir, new OllamaLLM(client, config.contextWindowOverride), {
      web: new OllamaWeb(client, config.ollamaApiKey),
      models: config.models,
      think: config.think ?? false,
      now: undefined,
    });
    const session = await deps.store.createSession('live');
    const events: StreamEvent[] = [];
    const { text } = await new ChatService(deps).sendMessage({
      userId: 'live',
      sessionId: session.id,
      content: 'My name is Ada Lovelace and my email is ada@example.com. Please save that to my profile, then reply in one short sentence.',
      emit: (e) => events.push(e),
    });
    const profile = await deps.store.getProfile('live');
    expect(JSON.stringify(profile)).toContain('Ada Lovelace');
    expect(JSON.stringify(profile)).toContain('ada@example.com');
    expect(events.some((e) => e.type === 'tool_call' && e.name === 'editProfile')).toBe(true);
    expect(events.find((e) => e.type === 'usage')).toMatchObject({ usage: { estimated: false } });
    expect(text.length).toBeGreaterThan(0);
  }, 180_000);

  it.skipIf(!config.ollamaApiKey)('web search works', async () => {
    const results = await new OllamaWeb(client, config.ollamaApiKey).search('Playwright PDF generation', 2);
    expect(results.length).toBeGreaterThan(0);
  }, 60_000);
});
