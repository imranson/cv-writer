import { describe, expect, it } from 'vitest';
import { cloudApiModelName, hostUrl, isCloudHost, LlmError, OllamaChatClient } from '../../src/llm/ollama.js';

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: any;
}

/** A fetch stand-in that answers from a list of responses (or errors to throw). */
function fakeFetch(responses: Array<{ status?: number; body: unknown } | Error>) {
  const sent: Sent[] = [];
  const impl = async (input: unknown, init: RequestInit = {}) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: JSON.parse(String(init.body)),
    });
    const next = responses.shift();
    if (!next) throw new Error('no response scripted');
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { impl: impl as typeof fetch, sent };
}

const ok = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  body: { model: 'm', created_at: '2026-10-04T00:00:00Z', message: { role: 'assistant', content: '', ...message }, done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 30, ...extra },
});

const connectionError = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

function client(host: string, responses: Parameters<typeof fakeFetch>[0], extra: Partial<ConstructorParameters<typeof OllamaChatClient>[0]> = {}) {
  const fetch = fakeFetch(responses);
  const delays: number[] = [];
  const c = new OllamaChatClient({
    host,
    fetch: fetch.impl,
    sleep: async (ms) => void delays.push(ms),
    retryDelayMs: 10,
    ...extra,
  });
  return { client: c, sent: fetch.sent, delays };
}

const request = {
  model: 'glm-5.3:cloud',
  messages: [
    { role: 'system' as const, content: 'sys' },
    { role: 'user' as const, content: 'hi' },
  ],
};

describe('model names and hosts', () => {
  it('maps local cloud-model names to the cloud API names', () => {
    expect(cloudApiModelName('glm-5.3:cloud')).toBe('glm-5.3');
    expect(cloudApiModelName('gpt-oss:120b-cloud')).toBe('gpt-oss:120b');
    expect(cloudApiModelName('deepseek-v4-pro')).toBe('deepseek-v4-pro');
    expect(cloudApiModelName('my-cloud-model:latest')).toBe('my-cloud-model:latest');
  });

  it('recognises the cloud host and parses hosts the way ollama-js does', () => {
    expect(isCloudHost('https://ollama.com')).toBe(true);
    expect(isCloudHost('https://api.ollama.com/')).toBe(true);
    expect(isCloudHost('http://127.0.0.1:11434')).toBe(false);
    expect(isCloudHost('notollama.com')).toBe(false);
    expect(hostUrl(':11434').href).toBe('http://127.0.0.1:11434/');
    expect(hostUrl('localhost:11434').hostname).toBe('localhost');
  });
});

describe('OllamaChatClient', () => {
  it('posts a non-streaming chat request to a local daemon with the model name unchanged', async () => {
    const { client: c, sent } = client('http://127.0.0.1:11434', [ok({ content: 'Hello' })]);
    const tools = [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: { type: 'object' } } }];
    const result = await c.chat({ ...request, tools, think: 'low' });

    expect(result).toEqual({ message: { role: 'assistant', content: 'Hello' }, promptTokens: 120, outputTokens: 30, doneReason: 'stop' });
    expect(sent[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(sent[0]!.body).toEqual({ model: 'glm-5.3:cloud', messages: request.messages, tools, think: 'low', stream: false });
    expect(sent[0]!.headers.authorization).toBeUndefined();
  });

  it('calls ollama.com with the bare model name and the API key', async () => {
    const { client: c, sent } = client('https://ollama.com', [ok({ content: 'Hi' })], { apiKey: 'secret-key' });
    await c.chat(request);
    expect(sent[0]!.url).toBe('https://ollama.com:443/api/chat');
    expect(sent[0]!.body.model).toBe('glm-5.3');
    expect(sent[0]!.headers.authorization).toBe('Bearer secret-key');
  });

  it('omits tools and think when not given', async () => {
    const { client: c, sent } = client('http://h:1', [ok({ content: 'x' })]);
    await c.chat(request);
    expect(Object.keys(sent[0]!.body).sort()).toEqual(['messages', 'model', 'stream']);
  });

  it('returns tool calls with their ids, parsing string arguments', async () => {
    const { client: c } = client('http://h:1', [
      ok({
        thinking: 'plan',
        tool_calls: [
          { id: 'call_1', function: { index: 0, name: 'save', arguments: { a: 1 } } },
          { function: { name: 'other', arguments: '{"b":2}' } },
          { function: { name: 'broken', arguments: '{not json' } },
        ],
      }),
    ]);
    const { message } = await c.chat(request);
    expect(message).toEqual({
      role: 'assistant',
      content: '',
      thinking: 'plan',
      tool_calls: [
        { id: 'call_1', function: { index: 0, name: 'save', arguments: { a: 1 } } },
        { function: { name: 'other', arguments: { b: 2 } } },
        { function: { name: 'broken', arguments: {} } },
      ],
    });
  });

  it('retries overloads and server errors with backoff', async () => {
    const { client: c, sent, delays } = client('http://h:1', [
      { status: 503, body: { error: 'overloaded' } },
      { status: 429, body: { error: 'rate limited' } },
      connectionError('ECONNRESET'),
      ok({ content: 'finally' }),
    ]);
    expect((await c.chat(request)).message.content).toBe('finally');
    expect(sent).toHaveLength(4);
    expect(delays).toEqual([10, 20, 40]);
  });

  it('gives up after the configured retries with a non-fatal error', async () => {
    const { client: c, sent } = client('http://h:1', [
      { status: 500, body: { error: 'boom' } },
      { status: 500, body: { error: 'boom' } },
    ], { retries: 1 });
    const err = await c.chat(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(err).toMatchObject({ fatal: false, status: 500, message: 'Ollama request failed (500): boom' });
    expect(sent).toHaveLength(2);
  });

  it('explains sign-in problems without retrying', async () => {
    const local = client('http://127.0.0.1:11434', [{ status: 401, body: { error: 'unauthorized' } }]);
    await expect(local.client.chat(request)).rejects.toMatchObject({ fatal: true, status: 401, message: expect.stringContaining('ollama signin') });
    expect(local.sent).toHaveLength(1);

    const cloud = client('https://ollama.com', [{ status: 401, body: { error: 'unauthorized' } }], { apiKey: 'bad' });
    await expect(cloud.client.chat(request)).rejects.toMatchObject({ fatal: true, message: expect.stringContaining('OLLAMA_API_KEY') });
  });

  it('explains unknown models', async () => {
    const { client: c } = client('http://127.0.0.1:11434', [{ status: 404, body: { error: "model 'nope:cloud' not found" } }]);
    await expect(c.chat({ ...request, model: 'nope:cloud' })).rejects.toMatchObject({
      fatal: true,
      message: expect.stringMatching(/Model "nope:cloud" was not found.*ollama pull nope:cloud/),
    });
  });

  it('explains when nothing is listening', async () => {
    const { client: c, sent } = client('http://127.0.0.1:9', [connectionError('ECONNREFUSED')]);
    await expect(c.chat(request)).rejects.toMatchObject({ fatal: true, message: expect.stringMatching(/Can't reach Ollama at http:\/\/127\.0\.0\.1:9/) });
    expect(sent).toHaveLength(1);
  });

  it('times out requests that take too long', async () => {
    const hanging = (async (_input: unknown, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason)))) as typeof fetch;
    const c = new OllamaChatClient({ host: 'http://h:1', fetch: hanging, timeoutMs: 20, retries: 0 });
    await expect(c.chat(request)).rejects.toMatchObject({ fatal: false, message: expect.stringMatching(/did not answer in time/) });
  });
});
