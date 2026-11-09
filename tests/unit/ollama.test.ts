import { describe, expect, it, vi } from 'vitest';
import { OllamaClient, readNdjson, resolveModelName } from '../../src/llm/ollama.js';

function ndjsonResponse(chunks: string[], status = 200) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(enc.encode(c));
        ctrl.close();
      },
    }),
    { status },
  );
}

describe('resolveModelName', () => {
  it('strips cloud suffixes only for ollama.com', () => {
    expect(resolveModelName('kimi-k2.6:cloud', 'https://ollama.com')).toBe('kimi-k2.6');
    expect(resolveModelName('gpt-oss:120b-cloud', 'https://ollama.com')).toBe('gpt-oss:120b');
    expect(resolveModelName('kimi-k2.6:cloud', 'http://127.0.0.1:11434')).toBe('kimi-k2.6:cloud');
  });
});

describe('readNdjson', () => {
  it('handles objects split across chunks and a trailing line without newline', async () => {
    const seen: any[] = [];
    await readNdjson(ndjsonResponse(['{"a":', '1}\n{"b":2}\n\n{"c"', ':3}']).body!, (o) => seen.push(o));
    expect(seen).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });
});

describe('OllamaClient.chat', () => {
  it('streams thinking and content, collects tool calls and usage', async () => {
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      const body = JSON.parse(init.body);
      expect(body).toMatchObject({ model: 'kimi-k2.6', stream: true, think: true });
      expect(body.tools).toHaveLength(1);
      expect(init.headers.authorization).toBe('Bearer secret');
      return ndjsonResponse([
        JSON.stringify({ message: { role: 'assistant', thinking: 'Hmm ' } }) + '\n',
        JSON.stringify({ message: { role: 'assistant', thinking: 'ok.' } }) + '\n',
        JSON.stringify({ message: { role: 'assistant', content: 'Hi', tool_calls: [{ function: { name: 'readCV', arguments: { jobId: 'j' } } }] } }) + '\n',
        JSON.stringify({ message: { role: 'assistant', content: '!' }, done: true, done_reason: 'stop', prompt_eval_count: 321, eval_count: 12, total_duration: 2_500_000_000 }) + '\n',
      ]);
    });
    const client = new OllamaClient({ host: 'https://ollama.com', apiKey: 'secret', fallbackContextWindow: 1000, fetchImpl: fetchImpl as any });
    const thinking: string[] = [];
    const text: string[] = [];
    const res = await client.chat({
      model: 'kimi-k2.6:cloud',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'readCV', description: '', parameters: {} } }],
      onThinking: (d) => thinking.push(d),
      onText: (d) => text.push(d),
    });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://ollama.com/api/chat');
    expect(thinking).toEqual(['Hmm ', 'ok.']);
    expect(text).toEqual(['Hi', '!']);
    expect(res).toMatchObject({ content: 'Hi!', thinking: 'Hmm ok.', doneReason: 'stop', usage: { promptTokens: 321, evalTokens: 12, durationMs: 2500 } });
    expect(res.toolCalls).toEqual([{ function: { name: 'readCV', arguments: { jobId: 'j' } } }]);
  });

  it('retries transient errors then succeeds', async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) return new Response('{"error":"overloaded"}', { status: 503 });
      return ndjsonResponse([JSON.stringify({ message: { content: 'ok' }, done: true }) + '\n']);
    });
    const client = new OllamaClient({ host: 'http://x', fallbackContextWindow: 1, fetchImpl: fetchImpl as any, retryDelayMs: 1 });
    expect((await client.chat({ model: 'm', messages: [] })).content).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('surfaces non-retryable errors and stream errors', async () => {
    const bad = new OllamaClient({ host: 'http://x', fallbackContextWindow: 1, fetchImpl: (async () => new Response('{"error":"model not found"}', { status: 404 })) as any });
    await expect(bad.chat({ model: 'm', messages: [] })).rejects.toThrow('Ollama 404: model not found');
    const streamErr = new OllamaClient({ host: 'http://x', fallbackContextWindow: 1, fetchImpl: (async () => ndjsonResponse(['{"error":"boom"}\n'])) as any });
    await expect(streamErr.chat({ model: 'm', messages: [] })).rejects.toThrow('Ollama: boom');
  });

  it('falls back to no-thinking for models that reject it', async () => {
    const bodies: any[] = [];
    const fetchImpl = vi.fn(async (_u: any, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.think) return new Response('{"error":"\\"m\\" does not support thinking"}', { status: 400 });
      return ndjsonResponse([JSON.stringify({ message: { content: 'plain' }, done: true }) + '\n']);
    });
    const client = new OllamaClient({ host: 'http://x', fallbackContextWindow: 1, fetchImpl: fetchImpl as any });
    expect((await client.chat({ model: 'm', messages: [] })).content).toBe('plain');
    await client.chat({ model: 'm', messages: [] });
    expect(bodies.map((b) => Boolean(b.think))).toEqual([true, false, false]);
  });
});

describe('OllamaClient.contextWindow', () => {
  it('reads context_length from /api/show and caches it', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model_info: { 'kimi-k2.context_length': 262144 } })));
    const client = new OllamaClient({ host: 'http://x', fallbackContextWindow: 1000, fetchImpl: fetchImpl as any });
    expect(await client.contextWindow('kimi')).toBe(262144);
    expect(await client.contextWindow('kimi')).toBe(262144);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('falls back when the model cannot be queried', async () => {
    const client = new OllamaClient({ host: 'http://x', fallbackContextWindow: 4096, fetchImpl: (async () => new Response('', { status: 404 })) as any });
    expect(await client.contextWindow('m')).toBe(4096);
  });
});
