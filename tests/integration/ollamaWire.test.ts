import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConversationService, type ServerEvent } from '../../src/agents/conversation.ts';
import { OllamaChatModel } from '../../src/llm/ollama.ts';
import { CV_HTML, LISTING, PROFILE, critiqueInput } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { FakeOllama } from '../support/fakeOllama.ts';

let ollama: FakeOllama;
let env: TestEnv;

beforeEach(async () => {
  ollama = await new FakeOllama(65_536).start();
  const model = new OllamaChatModel({ host: ollama.url, model: 'kimi-k2.6:cloud', apiKey: 'test-key' });
  env = await makeEnv({ models: { coordinator: model, writer: model, critic: model } });
});
afterEach(async () => {
  await ollama.stop();
  await env.cleanup();
});

describe('agents over the Ollama wire protocol', () => {
  it('runs a coordinator tool-calling turn end to end over HTTP', async () => {
    ollama.script(
      { thinking: 'Save the profile first.', tool_calls: [{ function: { name: 'update_profile', arguments: { markdown: PROFILE } } }] },
      { content: 'Profile saved — what job are you applying for?' },
    );
    const service = new ConversationService(env.deps, { compactThreshold: 0.8 });
    const session = await env.store.createSession();
    const events: ServerEvent[] = [];
    const saved = await service.sendMessage(session.id, 'Here is my background…', (e) => events.push(e));

    expect(await env.store.readProfile()).toBe(PROFILE);
    expect(saved.messages.at(-1)?.content).toBe('Profile saved — what job are you applying for?');
    expect(saved.context).toEqual({ tokens: 1234 + 56, limit: 65_536, estimated: false });

    const [first, second] = ollama.chatRequests();
    expect(first!.auth).toBe('Bearer test-key');
    expect(first!.body).toMatchObject({ model: 'kimi-k2.6:cloud', stream: true });
    expect(first!.body.messages[0]).toMatchObject({ role: 'system' });
    expect(first!.body.messages[0]!.content).toContain('CV coach');
    const updateTool = first!.body.tools!.find((t) => t.function.name === 'update_profile')!;
    expect(updateTool.type).toBe('function');
    expect(updateTool.function.parameters).toMatchObject({ type: 'object', required: ['markdown'], properties: { markdown: { type: 'string' } } });

    const followUp = second!.body.messages.slice(-2);
    expect(followUp[0]).toMatchObject({ role: 'assistant', thinking: 'Save the profile first.', tool_calls: [{ function: { name: 'update_profile' } }] });
    expect(followUp[1]).toEqual({ role: 'tool', content: expect.stringMatching(/^Profile saved \(\d+ words\)\.$/), tool_name: 'update_profile' });
    expect(events.filter((e) => e.type === 'thinking').length).toBeGreaterThan(0);
  });

  it('runs writer and critic subagents through the same protocol', async () => {
    await env.store.writeProfile(PROFILE);
    const job = await env.store.createJob({ title: 'Senior PM', company: 'Brightwave', listing: LISTING });
    ollama.script(
      { tool_calls: [{ function: { name: 'write_cv', arguments: JSON.stringify({ html: CV_HTML }) } }] }, // string arguments are tolerated
      { content: 'Drafted.' },
      { tool_calls: [{ function: { name: 'submit_critique', arguments: critiqueInput() } }] },
    );
    const { runWriter } = await import('../../src/agents/writer.ts');
    const { runCritic } = await import('../../src/agents/critic.ts');
    expect((await runWriter(env.deps, { jobId: job.id, instructions: 'Draft' })).changed).toBe(true);
    expect((await runCritic(env.deps, { jobId: job.id })).verdict).toBe('ready');
    const critic = ollama.chatRequests()[2]!.body;
    expect(critic.tools!.map((t) => t.function.name)).toEqual(['list_skills', 'read_skill', 'submit_critique']);
    expect(critic.messages[0]!.content).toContain('CV critique rubric');
  });

  it('surfaces server errors as a failed turn', async () => {
    ollama.script({ error: 'model "nope" not found', status: 404 });
    const service = new ConversationService(env.deps, { compactThreshold: 0.8 });
    const session = await env.store.createSession();
    const events: ServerEvent[] = [];
    await service.sendMessage(session.id, 'hi', (e) => events.push(e));
    expect(events.at(-1)).toEqual({ type: 'error', message: expect.stringContaining('not found') });
  });

  it('reads the context window from /api/show', async () => {
    const model = new OllamaChatModel({ host: ollama.url, model: 'm' });
    expect(await model.contextLength()).toBe(65_536);
  });
});
