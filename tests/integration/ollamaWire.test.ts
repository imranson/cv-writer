import { afterEach, describe, expect, it } from 'vitest';
import { createCoordinator } from '../../src/agents/coordinator.js';
import { OllamaChatClient } from '../../src/llm/ollama.js';
import { sampleJob, tempStore } from '../helpers.js';
import { startFakeOllama } from '../support/fakeOllama.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function server(...args: Parameters<typeof startFakeOllama>) {
  const s = await startFakeOllama(...args);
  servers.push(s);
  return s;
}

/** The real ollama-js client and the real coordinator, talking HTTP to a stand-in Ollama server. */
describe('coordinator over the Ollama HTTP API', () => {
  it('sends tool definitions, executes the returned tool call and sends the result back', async () => {
    const ollama = await server([
      {
        message: {
          tool_calls: [{ id: 'call_abc', function: { index: 0, name: 'save_job_listing', arguments: sampleJob() } }],
        },
      },
      { message: { content: 'Saved the Acme listing.' } },
    ]);
    const store = await tempStore();
    const coordinator = createCoordinator({
      store,
      client: new OllamaChatClient({ host: ollama.url, retryDelayMs: 1 }),
      model: 'glm-5.3:cloud',
      think: true,
      showCv: () => {},
      writeCv: async () => {
        throw new Error('unused');
      },
    });

    const result = await coordinator.run('Here is the job: ...');
    expect(result.reply).toBe('Saved the Acme listing.');
    expect((await store.listJobs()).map((j) => j.company)).toEqual(['Acme Health']);

    const [first, second] = ollama.requests.map((r) => r.body);
    expect(first).toMatchObject({ model: 'glm-5.3:cloud', stream: false, think: true });
    const saveSpec = first.tools.find((t: any) => t.function.name === 'save_job_listing');
    expect(saveSpec.function.parameters).toMatchObject({
      type: 'object',
      required: ['title', 'company', 'description'],
      properties: { keywords: { type: 'array', items: { type: 'string' } } },
    });
    expect(second.messages.slice(-2)).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_abc', function: { index: 0, name: 'save_job_listing', arguments: sampleJob() } }],
      },
      {
        role: 'tool',
        tool_name: 'save_job_listing',
        tool_call_id: 'call_abc',
        content: expect.stringContaining('"jobId": "acme-health-graduate-software-engineer-id1"'),
      },
    ]);
    expect(coordinator.usage).toEqual({ requests: 2, promptTokens: 100, outputTokens: 20 });
  });

  it('retries a transient server error and surfaces fatal ones', async () => {
    const ollama = await server([
      { status: 503, error: 'server busy' },
      { message: { content: 'Hello!' } },
      { status: 404, error: "model 'nope:cloud' not found" },
    ]);
    const client = new OllamaChatClient({ host: ollama.url, retryDelayMs: 1 });
    const request = { model: 'nope:cloud', messages: [{ role: 'user' as const, content: 'hi' }] };
    expect((await client.chat(request)).message.content).toBe('Hello!');
    await expect(client.chat(request)).rejects.toMatchObject({ fatal: true, status: 404, message: expect.stringContaining('ollama pull nope:cloud') });
    expect(ollama.requests).toHaveLength(3);
  });
});
