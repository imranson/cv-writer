import { describe, expect, it } from 'vitest';
import { describeError, isRetryable, modelNameFor, normaliseMessage, OllamaChatModel } from '../../src/llm/ollama.js';
import type { ChatDelta } from '../../src/llm/types.js';
import { stripThinking } from '../../src/util/text.js';

function fakeFetch(responses: Array<Response | Error>) {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) });
    const next = responses.shift();
    if (!next) throw new Error('no response scripted');
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'Content-Type': 'application/x-ndjson' } });
const done = (message: Record<string, unknown>) => ({ model: 'm', created_at: 'x', message: { role: 'assistant', content: '', ...message }, done: true, prompt_eval_count: 12, eval_count: 3 });
const noSleep = async () => undefined;

describe('helpers', () => {
  it('drops the :cloud suffix only when calling ollama.com directly', () => {
    expect(modelNameFor('https://ollama.com', 'glm-5.3:cloud')).toBe('glm-5.3');
    expect(modelNameFor('https://ollama.com', 'gpt-oss:120b-cloud')).toBe('gpt-oss:120b');
    expect(modelNameFor('http://127.0.0.1:11434', 'glm-5.3:cloud')).toBe('glm-5.3:cloud');
  });

  it('classifies retryable errors', () => {
    expect(isRetryable({ status_code: 429 })).toBe(true);
    expect(isRetryable({ status_code: 503 })).toBe(true);
    expect(isRetryable({ status_code: 400 })).toBe(false);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(Object.assign(new Error('x'), { name: 'TimeoutError' }))).toBe(true);
    expect(isRetryable(new Error('bad request'))).toBe(false);
  });

  it('explains common failures', () => {
    expect(describeError({ status_code: 401, message: 'unauthorized' }, 'h')).toMatch(/ollama signin/);
    expect(describeError({ status_code: 404, message: 'model "x" not found' }, 'h')).toMatch(/could not find the model/);
    expect(describeError(new TypeError('fetch failed'), 'http://127.0.0.1:11434')).toMatch(/Could not reach Ollama at http:\/\/127\.0\.0\.1:11434/);
  });

  it('strips leaked reasoning and parses string arguments', () => {
    expect(stripThinking('I should say ok.</think>ok')).toBe('ok');
    expect(stripThinking('<think>still thinking')).toBe('');
    expect(stripThinking('plain')).toBe('plain');
    const m = normaliseMessage({ content: 'x</think> hi', tool_calls: [{ function: { name: 't', arguments: '{"a":1}' } }, { function: { name: 'u', arguments: '{bad' } }] });
    expect(m.content).toBe('hi');
    expect(m.tool_calls).toEqual([{ function: { name: 't', arguments: { a: 1 } } }, { function: { name: 'u', arguments: { __unparseable: '{bad' } } }]);
  });
});

describe('OllamaChatModel', () => {
  it('sends a non-streaming chat with tools and think, and reads usage', async () => {
    const f = fakeFetch([json(done({ content: 'hello', tool_calls: [{ function: { name: 'save', arguments: { x: 1 } } }] }))]);
    const model = new OllamaChatModel({ host: 'http://127.0.0.1:11434', fetch: f.impl, sleep: noSleep });
    const res = await model.chat({
      model: 'glm-5.3:cloud',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'save', description: 'd', parameters: { type: 'object' } } }],
      think: 'low',
    });
    expect(f.calls[0]!.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(f.calls[0]!.body).toMatchObject({ model: 'glm-5.3:cloud', stream: false, think: 'low', tools: [{ type: 'function' }] });
    expect(res.message).toEqual({ role: 'assistant', content: 'hello', tool_calls: [{ function: { name: 'save', arguments: { x: 1 } } }] });
    expect(res.usage).toEqual({ promptTokens: 12, outputTokens: 3 });
  });

  it('authenticates against ollama.com with an API key', async () => {
    const f = fakeFetch([json(done({ content: 'ok' }))]);
    await new OllamaChatModel({ host: 'https://ollama.com', apiKey: 'secret', fetch: f.impl }).chat({ model: 'glm-5.3:cloud', messages: [] });
    expect(f.calls[0]!.headers.get('authorization')).toBe('Bearer secret');
    expect(f.calls[0]!.body.model).toBe('glm-5.3');
  });

  it('streams content and thinking deltas and collects tool calls', async () => {
    const f = fakeFetch([
      ndjson([
        { model: 'm', message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
        { model: 'm', message: { role: 'assistant', content: 'Hel' }, done: false },
        { model: 'm', message: { role: 'assistant', content: 'lo', tool_calls: [{ function: { name: 't', arguments: {} } }] }, done: false },
        done({}),
      ]),
    ]);
    const deltas: ChatDelta[] = [];
    const res = await new OllamaChatModel({ host: 'http://h:1', fetch: f.impl }).chat({ model: 'm', messages: [] }, (d) => deltas.push(d));
    expect(f.calls[0]!.body.stream).toBe(true);
    expect(deltas).toEqual([{ thinking: 'hmm' }, { content: 'Hel' }, { content: 'lo' }]);
    expect(res.message).toEqual({ role: 'assistant', content: 'Hello', thinking: 'hmm', tool_calls: [{ function: { name: 't', arguments: {} } }] });
    expect(res.usage.promptTokens).toBe(12);
  });

  it('retries transient failures with backoff, then succeeds', async () => {
    const waits: number[] = [];
    const f = fakeFetch([json({ error: 'overloaded' }, 503), new TypeError('fetch failed'), json(done({ content: 'ok' }))]);
    const res = await new OllamaChatModel({ host: 'http://h:1', fetch: f.impl, sleep: async (ms) => void waits.push(ms) }).chat({ model: 'm', messages: [] });
    expect(res.message.content).toBe('ok');
    expect(waits).toEqual([1000, 2000]);
  });

  it('tells the stream consumer to reset before retrying', async () => {
    const f = fakeFetch([json({ error: 'busy' }, 429), ndjson([done({ content: 'fine' })])]);
    const deltas: ChatDelta[] = [];
    await new OllamaChatModel({ host: 'http://h:1', fetch: f.impl, sleep: noSleep }).chat({ model: 'm', messages: [] }, (d) => deltas.push(d));
    expect(deltas[0]).toEqual({ reset: true });
  });

  it('gives up on a stream that stops sending, and retries it', async () => {
    let calls = 0;
    const stalled = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      const body = new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`${JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'Hel' }, done: false })}\n`));
          // ...and then nothing more; like real fetch, an abort errors the body.
          init?.signal?.addEventListener('abort', () => c.error(init.signal!.reason));
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
    }) as unknown as typeof fetch;
    const deltas: ChatDelta[] = [];
    const model = new OllamaChatModel({ host: 'http://h:1', fetch: stalled, sleep: noSleep, idleTimeoutMs: 50, retries: 1 });
    await expect(model.chat({ model: 'm', messages: [] }, (d) => deltas.push(d))).rejects.toThrow(/stopped responding/);
    expect(calls).toBe(2);
    expect(deltas).toContainEqual({ reset: true });
  });

  it('does not retry client errors and explains them', async () => {
    const f = fakeFetch([json({ error: 'unauthorized' }, 401)]);
    await expect(new OllamaChatModel({ host: 'http://h:1', fetch: f.impl, sleep: noSleep }).chat({ model: 'm', messages: [] })).rejects.toThrow(/ollama signin/);
    expect(f.calls).toHaveLength(1);
  });

  it('gives up after the retry budget', async () => {
    const f = fakeFetch([json({ error: 'x' }, 500), json({ error: 'x' }, 500)]);
    await expect(new OllamaChatModel({ host: 'http://h:1', fetch: f.impl, sleep: noSleep, retries: 1 }).chat({ model: 'm', messages: [] })).rejects.toThrow(/Ollama error/);
    expect(f.calls).toHaveLength(2);
  });
});
