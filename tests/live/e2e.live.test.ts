/**
 * Live tests against a real Ollama model (default kimi-k2.6:cloud). Opt-in and slow:
 *   npm run test:live
 * Requires a running Ollama daemon signed in for cloud models, or OLLAMA_API_KEY for ollama.com.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConversationService } from '../../src/agents/conversation.ts';
import { runCritic } from '../../src/agents/critic.ts';
import { runWriter } from '../../src/agents/writer.ts';
import { loadConfig } from '../../src/config.ts';
import { runChecks } from '../../src/cv/checks.ts';
import { createOllamaModels } from '../../src/server/runtime.ts';
import { CV_HTML, LISTING, PROFILE } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';

let env: TestEnv;

beforeAll(async () => {
  env = await makeEnv({ models: createOllamaModels(loadConfig()) });
});
afterAll(() => env.cleanup());

describe.runIf(process.env.LIVE)('live Ollama model', () => {
  it('coordinator saves facts the user shares to the profile', async () => {
    const service = new ConversationService(env.deps, { compactThreshold: 0.8 });
    const session = await env.store.createSession();
    const saved = await service.sendMessage(
      session.id,
      'Hi, I am Priya Shah, a backend engineer in Manchester (priya.shah@example.com). I have worked at Globex since 2019 building Go microservices. Please save this to my profile.',
    );
    expect(saved.messages.at(-1)?.role).toBe('assistant');
    expect(saved.messages.at(-1)?.content.length).toBeGreaterThan(10);
    const profile = await env.store.readProfile();
    expect(profile).toMatch(/Priya/);
    expect(profile).toMatch(/Globex/);
    expect(saved.context.estimated).toBe(false);
  }, 300_000);

  it('writer drafts a truthful CV from the profile', async () => {
    await env.store.writeProfile(PROFILE);
    const job = await env.store.createJob({ title: 'Senior Product Manager', company: 'Brightwave', listing: LISTING });
    const result = await runWriter(env.deps, { jobId: job.id, instructions: 'Draft a first version of the CV.' });
    expect(result.changed).toBe(true);
    const html = (await env.store.readCv(job.id))!;
    expect(html).toContain('<h1');
    expect(html).toMatch(/Alex Morgan/);
    const blocking = runChecks(html, { profile: PROFILE }).filter((f) => f.severity === 'error').map((f) => f.id);
    expect(blocking).not.toContain('unverified-contact');
    expect(blocking).not.toContain('placeholder');
  }, 600_000);

  it('critic returns a structured, scored critique', async () => {
    await env.store.writeProfile(PROFILE);
    const job = await env.store.createJob({ title: 'Senior Product Manager', company: 'Brightwave', listing: LISTING });
    await env.store.writeCv(job.id, CV_HTML.replace('40,000 patients', '400,000 patients'));
    const critique = await runCritic(env.deps, { jobId: job.id });
    expect(critique.score).toBeGreaterThanOrEqual(0);
    expect(critique.score).toBeLessThanOrEqual(100);
    expect(['ready', 'needs_work', 'not_ready']).toContain(critique.verdict);
    expect(critique.coverage.length).toBeGreaterThan(0);
    // The inflated metric contradicts the profile and should be caught.
    expect(JSON.stringify(critique.factualIssues)).toMatch(/400,000/);
  }, 600_000);
});
