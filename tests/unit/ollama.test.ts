import { describe, expect, it } from 'vitest';
import { normaliseArguments, OllamaChatModel, toOllamaMessages, toOllamaTools } from '../../src/llm/ollama.ts';
import { isAbortError } from '../../src/llm/types.ts';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Headers;
}

/** fetch double that answers /api/chat with NDJSON chunks and /api/show with model info. */
function fakeFetch(chunks: object[], opts: { show?: object; status?: number; hang?: boolean } = {}) {
  const captured: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    captured.push({ url, body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) });
    if (url.endsWith('/api/show')) {
      return new Response(JSON.stringify(opts.show ?? {}), { status: opts.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        for (const c of chunks) controller.enqueue(enc.encode(`${JSON.stringify(c)}\n`));
        if (opts.hang) {
          signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
          return;
        }
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } });
  };
  return { fn: fn as typeof fetch, captured };
}

const chunk = (message: object, extra: object = {}) => ({ model: 'm', created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done: false, ...extra });
const done = (extra: object = {}) => ({ ...chunk({}), done: true, done_reason: 'stop', prompt_eval_count: 120, eval_count: 30, ...extra });

describe('message conversion', () => {
  it('maps internal messages and tools to the Ollama wire format', () => {
    expect(
      toOllamaMessages([
        { role: 'assistant', content: '', thinking: 't', toolCalls: [{ name: 'f', arguments: { a: 1 } }] },
        { role: 'tool', content: 'r', toolName: 'f' },
      ]),
    ).toEqual([
      { role: 'assistant', content: '', thinking: 't', tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }] },
      { role: 'tool', content: 'r', tool_name: 'f' },
    ]);
    expect(toOllamaTools([{ name: 'f', description: 'd', parameters: { type: 'object' } }])).toEqual([
      { type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } },
    ]);
  });

  it('normalises string tool arguments', () => {
    expect(normaliseArguments('{"a":1}')).toEqual({ a: 1 });
    expect(normaliseArguments('not json')).toEqual({});
    expect(normaliseArguments(['x'])).toEqual({});
    expect(normaliseArguments({ b: 2 })).toEqual({ b: 2 });
  });
});

describe('OllamaChatModel', () => {
  it('streams content and thinking, collects tool calls and usage', async () => {
    const { fn, captured } = fakeFetch([
      chunk({ thinking: 'Let me ' }),
      chunk({ thinking: 'think.' }),
      chunk({ content: 'Hel' }),
      chunk({ content: 'lo' }),
      chunk({ tool_calls: [{ function: { name: 'save', arguments: { x: 1 } } }] }),
      done(),
    ]);
    const model = new OllamaChatModel({ host: 'http://ollama.test', model: 'kimi-k2.6:cloud', apiKey: 'secret', think: 'high', temperature: 0.2, fetch: fn });
    const deltas: string[] = [];
    const r = await model.chat({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'save', description: 'd', parameters: { type: 'object' } }],
      onDelta: (d) => deltas.push(d.content ?? `[${d.thinking}]`),
    });
    expect(r.message).toEqual({ role: 'assistant', content: 'Hello', thinking: 'Let me think.', toolCalls: [{ name: 'save', arguments: { x: 1 } }] });
    expect(r.usage).toEqual({ promptTokens: 120, completionTokens: 30 });
    expect(r.doneReason).toBe('stop');
    expect(deltas).toEqual(['[Let me ]', '[think.]', 'Hel', 'lo']);
    const req = captured[0]!;
    expect(new URL(req.url)).toMatchObject({ hostname: 'ollama.test', pathname: '/api/chat' });
    expect(req.headers.get('authorization')).toBe('Bearer secret');
    expect(req.body).toMatchObject({ model: 'kimi-k2.6:cloud', stream: true, think: 'high', options: { temperature: 0.2 } });
    expect((req.body.tools as unknown[]).length).toBe(1);
  });

  it('omits tools when none are given', async () => {
    const { fn, captured } = fakeFetch([chunk({ content: 'x' }), done()]);
    await new OllamaChatModel({ host: 'http://o', model: 'm', fetch: fn }).chat({ messages: [] });
    expect(captured[0]!.body.tools).toBeUndefined();
    expect(captured[0]!.headers.get('authorization')).toBeNull();
  });

  it('aborts an in-flight stream', async () => {
    const { fn } = fakeFetch([chunk({ content: 'partial' })], { hang: true });
    const model = new OllamaChatModel({ host: 'http://o', model: 'm', fetch: fn });
    const controller = new AbortController();
    const pending = model.chat({ messages: [], signal: controller.signal, onDelta: () => controller.abort() });
    await expect(pending).rejects.toSatisfy(isAbortError);
  });

  it('reads the context length from model info, with fallbacks', async () => {
    const { fn } = fakeFetch([], { show: { model_info: { 'kimi-k2.context_length': 262144 } } });
    expect(await new OllamaChatModel({ host: 'http://o', model: 'm', fetch: fn }).contextLength()).toBe(262144);
    const none = fakeFetch([], { show: {} });
    expect(await new OllamaChatModel({ host: 'http://o', model: 'm', fetch: none.fn, fallbackContextLength: 4096 }).contextLength()).toBe(4096);
    const failing = fakeFetch([], { status: 500 });
    expect(await new OllamaChatModel({ host: 'http://o', model: 'm', fetch: failing.fn }).contextLength()).toBe(131072);
    expect(await new OllamaChatModel({ host: 'http://o', model: 'm', fetch: failing.fn, contextLength: 8000 }).contextLength()).toBe(8000);
  });
});
