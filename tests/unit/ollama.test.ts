import { describe, expect, it, vi } from 'vitest';
import { createOllamaClient, normalizeModel } from '../../src/llm/ollama.js';

function ndjson(lines: unknown[], splitAt?: number): Response {
  const text = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (splitAt) {
        controller.enqueue(enc.encode(text.slice(0, splitAt)));
        controller.enqueue(enc.encode(text.slice(splitAt)));
      } else controller.enqueue(enc.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'application/x-ndjson' } });
}

// Shape captured from a real kimi-k2.6:cloud response.
const toolCallStream = [
  { message: { role: 'assistant', content: '', thinking: 'I should use' }, done: false },
  { message: { role: 'assistant', content: '', thinking: ' the calc tool.' }, done: false },
  {
    message: { role: 'assistant', content: '', tool_calls: [{ id: 'functions.calc:0', function: { index: 0, name: 'calc', arguments: { expression: '17*23' } } }] },
    done: false,
  },
  { message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 55, eval_count: 49 },
];

describe('Ollama client', () => {
  it('strips cloud suffixes only for ollama.com', () => {
    expect(normalizeModel('kimi-k2.6:cloud', 'https://ollama.com')).toBe('kimi-k2.6');
    expect(normalizeModel('gpt-oss:120b-cloud', 'https://ollama.com')).toBe('gpt-oss:120b');
    expect(normalizeModel('kimi-k2.6:cloud', 'http://localhost:11434')).toBe('kimi-k2.6:cloud');
  });

  it('streams thinking, content and tool calls, and reports usage', async () => {
    const fetchImpl = vi.fn(async (_url: any, _init?: any) => ndjson(toolCallStream, 40));
    const client = createOllamaClient({ host: 'https://ollama.com/', apiKey: 'k', fetchImpl: fetchImpl as any });
    const thinking: string[] = [];
    const res = await client.chat(
      {
        model: 'kimi-k2.6:cloud',
        messages: [
          { role: 'user', content: 'hi', at: 'ignored' },
          { role: 'tool', content: '391', tool_name: 'calc', tool_call_id: 'functions.calc:0' },
        ],
        tools: [{ type: 'function', function: { name: 'calc', description: 'd', parameters: { type: 'object' } } }],
      },
      { onThinking: (d) => thinking.push(d) },
    );
    const [url, init] = fetchImpl.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(url).toBe('https://ollama.com/api/chat');
    expect(init.headers.authorization).toBe('Bearer k');
    expect(body.model).toBe('kimi-k2.6');
    expect(body.stream).toBe(true);
    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(body.messages[1]).toEqual({ role: 'tool', content: '391', tool_name: 'calc', tool_call_id: 'functions.calc:0' });
    expect(thinking.join('')).toBe('I should use the calc tool.');
    expect(res.message.tool_calls).toEqual([{ id: 'functions.calc:0', function: { name: 'calc', arguments: { expression: '17*23' } } }]);
    expect(res.usage).toEqual({ promptTokens: 55, completionTokens: 49 });
    expect(res.doneReason).toBe('stop');
  });

  it('parses string arguments and streams content deltas', async () => {
    const fetchImpl = vi.fn(async () =>
      ndjson([
        { message: { content: 'Hel' }, done: false },
        { message: { content: 'lo', tool_calls: [{ function: { name: 'x', arguments: '{"a":1}' } }] }, done: false },
        { done: true },
      ]),
    );
    const client = createOllamaClient({ host: 'http://localhost:11434', fetchImpl: fetchImpl as any });
    const deltas: string[] = [];
    const res = await client.chat({ model: 'm', messages: [] }, { onContent: (d) => deltas.push(d) });
    expect(deltas).toEqual(['Hel', 'lo']);
    expect(res.message.content).toBe('Hello');
    expect(res.message.tool_calls?.[0].function.arguments).toEqual({ a: 1 });
    expect(res.usage).toBeUndefined();
  });

  it('retries 5xx then surfaces errors with hints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(ndjson([{ message: { content: 'ok' }, done: true }]));
    const client = createOllamaClient({ host: 'http://h', fetchImpl: fetchImpl as any, retryDelayMs: 1 });
    expect((await client.chat({ model: 'm', messages: [] })).message.content).toBe('ok');

    const unauthorized = createOllamaClient({
      host: 'http://h',
      fetchImpl: (async () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })) as any,
    });
    await expect(unauthorized.chat({ model: 'm', messages: [] })).rejects.toThrow(/401: unauthorized.*OLLAMA_API_KEY/);

    const streamError = createOllamaClient({ host: 'http://h', fetchImpl: (async () => ndjson([{ error: 'model not found' }])) as any });
    await expect(streamError.chat({ model: 'm', messages: [] })).rejects.toThrow('model not found');
  });

  it('detects and caches the context window from /api/show', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model_info: { 'kimi-k2.context_length': 262144 } })));
    const client = createOllamaClient({ host: 'http://h', fetchImpl: fetchImpl as any });
    expect(await client.contextWindow!('kimi-k2.6:cloud')).toBe(262144);
    expect(await client.contextWindow!('kimi-k2.6:cloud')).toBe(262144);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const failing = createOllamaClient({ host: 'http://h', fetchImpl: (async () => new Response('no', { status: 404 })) as any });
    expect(await failing.contextWindow!('m')).toBeUndefined();
  });
});
