import { describe, expect, it } from 'vitest';
import { OllamaLLM } from '../../src/llm/ollama.js';
import type { Delta } from '../../src/llm/types.js';

function ndjson(lines: object[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
}

function recordingFetch(handler: (url: string, body: any) => Response) {
  const calls: { url: string; body: any; headers: Headers }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, headers: new Headers(init?.headers) });
    return handler(url, body);
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe('OllamaLLM', () => {
  it('streams content and thinking, accumulates tool calls and reports usage', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      ndjson([
        { model: 'm', message: { role: 'assistant', content: '', thinking: 'hmm ' }, done: false },
        { model: 'm', message: { role: 'assistant', content: 'Saving ' }, done: false },
        { model: 'm', message: { role: 'assistant', content: 'now.', tool_calls: [{ function: { name: 'writeProfile', arguments: { profile: { name: 'Ada' } } } }] }, done: false },
        { model: 'm', message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1200, eval_count: 34 },
      ]),
    );
    const llm = new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl });
    const deltas: Delta[] = [];
    const tools = [{ type: 'function' as const, function: { name: 'writeProfile', description: 'd', parameters: { type: 'object' } } }];
    const result = await llm.chat({ agent: 'coordinator', model: 'kimi-k2.6:cloud', messages: [{ role: 'user', content: 'hi' }], tools }, (d) => deltas.push(d));

    expect(calls[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(calls[0].body).toMatchObject({ model: 'kimi-k2.6:cloud', stream: true, messages: [{ role: 'user', content: 'hi' }], tools });
    expect(calls[0].headers.get('authorization')).toBeNull();
    expect(calls[0].body).not.toHaveProperty('think');
    expect(deltas).toEqual([{ thinking: 'hmm ' }, { content: 'Saving ' }, { content: 'now.' }]);
    expect(result).toEqual({
      message: {
        role: 'assistant',
        content: 'Saving now.',
        thinking: 'hmm ',
        tool_calls: [{ function: { name: 'writeProfile', arguments: { profile: { name: 'Ada' } } } }],
      },
      usage: { promptTokens: 1200, completionTokens: 34 },
    });
  });

  it('passes the thinking setting through when configured', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ndjson([{ message: { role: 'assistant', content: 'x' }, done: true }]));
    await new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl }).chat({ agent: 'writer', model: 'm', messages: [], tools: [], think: false });
    expect(calls[0].body.think).toBe(false);
  });

  it('sends the API key only to ollama.com', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ndjson([{ message: { role: 'assistant', content: 'x' }, done: true }]));
    await new OllamaLLM({ host: 'https://ollama.com', apiKey: 'sk-1', fetch: fetchImpl }).chat({ agent: 'critic', model: 'm', messages: [], tools: [] });
    await new OllamaLLM({ host: 'http://evil.example', apiKey: 'sk-1', fetch: fetchImpl }).chat({ agent: 'critic', model: 'm', messages: [], tools: [] });
    expect(calls[0].headers.get('authorization')).toBe('Bearer sk-1');
    expect(calls[1].headers.get('authorization')).toBeNull();
  });

  it('reads the context window from model info and caches it', async () => {
    const { calls, fetchImpl } = recordingFetch(() =>
      Response.json({ model_info: { 'general.architecture': 'kimi-k2', 'kimi-k2.context_length': 262144 }, details: {} }),
    );
    const llm = new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl });
    expect(await llm.contextWindow('kimi-k2.6:cloud')).toBe(262144);
    expect(await llm.contextWindow('kimi-k2.6:cloud')).toBe(262144);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: 'http://127.0.0.1:11434/api/show', body: { model: 'kimi-k2.6:cloud' } });
  });

  it('returns undefined (and retries later) when the model info is unavailable', async () => {
    let up = false;
    const { fetchImpl } = recordingFetch(() =>
      up ? Response.json({ model_info: { 'x.context_length': 4096 } }) : Response.json({ error: 'down' }, { status: 500 }),
    );
    const llm = new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl });
    expect(await llm.contextWindow('m')).toBeUndefined();
    up = true;
    expect(await llm.contextWindow('m')).toBe(4096);
  });

  it('surfaces API errors', async () => {
    const { fetchImpl } = recordingFetch(() => Response.json({ error: 'model "nope" not found' }, { status: 404 }));
    const llm = new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl });
    await expect(llm.chat({ agent: 'writer', model: 'nope', messages: [], tools: [] })).rejects.toThrow('model "nope" not found');
  });

  it('does not start when already aborted', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ndjson([]));
    const controller = new AbortController();
    controller.abort();
    const llm = new OllamaLLM({ host: 'http://127.0.0.1:11434', fetch: fetchImpl });
    await expect(llm.chat({ agent: 'writer', model: 'm', messages: [], tools: [], signal: controller.signal })).rejects.toThrow('Stopped by user');
    expect(calls).toHaveLength(0);
  });
});
