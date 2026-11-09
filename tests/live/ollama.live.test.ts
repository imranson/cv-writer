/**
 * Live smoke test against a real Ollama endpoint (local daemon signed in to ollama.com, or
 * OLLAMA_API_KEY for ollama.com). Skipped unless LIVE_OLLAMA=1.
 *   LIVE_OLLAMA=1 npx vitest run tests/live
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { runAgent } from '../../src/agents/runner.js';
import { SkillRegistry } from '../../src/agents/skills.js';
import { OllamaClient } from '../../src/llm/ollama.js';
import { applyEvent, emptyActivity } from '../../src/shared/activity.js';
import { collector, createTestDb, SKILLS_DIR } from '../helpers.js';

const live = process.env.LIVE_OLLAMA === '1';

describe.skipIf(!live)('live Ollama', () => {
  const config = loadConfig();
  const llm = new OllamaClient({ host: config.ollamaHost, apiKey: config.ollamaApiKey, fallbackContextWindow: config.contextWindow });
  let env: Awaited<ReturnType<typeof createTestDb>>;
  beforeAll(async () => {
    env = await createTestDb();
  });
  afterAll(() => env.db.close());

  it('streams a reply and reports the context window', async () => {
    const thinking: string[] = [];
    const res = await llm.chat({ model: config.models.critic, messages: [{ role: 'user', content: 'Reply with just the word OK.' }], onThinking: (d) => thinking.push(d) });
    expect(res.content).toMatch(/ok/i);
    expect(res.usage.promptTokens).toBeGreaterThan(0);
    expect(await llm.contextWindow(config.models.critic)).toBeGreaterThan(8000);
  }, 120_000);

  it('critic uses its tools on a real CV and returns a score', async () => {
    const { repo } = env;
    const user = await repo.createUser({ email: 'live@example.com', name: 'Live', passwordHash: 'h' });
    const job = await repo.createJob(user.id, { title: 'Data Engineer', company: 'Acme', requirements: ['Python', 'Airflow', 'AWS'] });
    await repo.saveCvHtml(user.id, job.id, '<header><h1>Sam Doe</h1></header><section><h2>Experience</h2><div class="role"><h3>Data Engineer, Foo Ltd</h3><ul><li>Built Airflow pipelines processing 2TB/day on AWS.</li><li>Responsible for reports.</li></ul></div></section>');
    const { events, emit } = collector();
    const res = await runAgent(
      { llm, repo, skills: new SkillRegistry(SKILLS_DIR), config, web: {} },
      { agent: 'critic', userId: user.id, input: `Job ID: ${job.id}\n\nGive a complete review.`, emit, signal: AbortSignal.timeout(300_000), focusJobId: job.id },
    );
    const activity = emptyActivity();
    for (const e of events) applyEvent(activity, e);
    const tools = events.filter((e) => e.type === 'tool_call').map((e: any) => e.name);
    console.log('critic tools:', tools, '\n', res.output.slice(0, 400));
    expect(tools).toContain('readCV');
    expect(res.output).toMatch(/score/i);
  }, 300_000);
});
