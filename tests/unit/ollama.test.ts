import { describe, expect, it, vi } from 'vitest';
import { OllamaLLM, OllamaWeb, assertPublicHttpUrl, contextLengthFromModelInfo } from '../../src/llm/ollama';

function fakeStream(chunks: any[]) {
  let aborted = false;
  return {
    abort: () => (aborted = true),
    get aborted() {
      return aborted;
    },
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) {
        if (aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        yield c;
      }
    },
  };
}

describe('OllamaLLM.chat', () => {
  it('streams deltas and assembles content, thinking, tool calls and token counts', async () => {
    const client: any = {
      chat: vi.fn(async () =>
        fakeStream([
          { message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
          { message: { role: 'assistant', content: 'Hello ' }, done: false },
          { message: { role: 'assistant', content: 'there' }, done: false },
          { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'evalMath', arguments: { expression: '1' } } }] }, done: false },
          { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 120, eval_count: 30 },
        ]),
      ),
    };
    const deltas: any[] = [];
    const llm = new OllamaLLM(client);
    const result = await llm.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [], think: false, onDelta: (d) => deltas.push(d) });
    expect(client.chat).toHaveBeenCalledWith(expect.objectContaining({ model: 'm', stream: true, think: false }));
    expect(deltas).toEqual([{ thinking: 'hmm' }, { content: 'Hello ' }, { content: 'there' }]);
    expect(result).toEqual({
      message: { role: 'assistant', content: 'Hello there', thinking: 'hmm', tool_calls: [{ function: { name: 'evalMath', arguments: { expression: '1' } } }] },
      promptTokens: 120,
      outputTokens: 30,
    });
  });

  it('aborts the stream when the signal fires', async () => {
    const controller = new AbortController();
    const stream = fakeStream([
      { message: { content: 'a' }, done: false },
      { message: { content: 'b' }, done: false },
    ]);
    const llm = new OllamaLLM({ chat: async () => stream } as any);
    await expect(
      llm.chat({ model: 'm', messages: [], tools: [], signal: controller.signal, onDelta: () => controller.abort() }),
    ).rejects.toThrow('Aborted');
    expect(stream.aborted).toBe(true);
  });
});

describe('context window detection', () => {
  it('reads <arch>.context_length from model info', () => {
    expect(contextLengthFromModelInfo({ 'general.architecture': 'kimi-k2', 'kimi-k2.context_length': 262144 })).toBe(262144);
    expect(contextLengthFromModelInfo(new Map([['llama.context_length', 8192]]))).toBe(8192);
    expect(contextLengthFromModelInfo({})).toBeUndefined();
  });

  it('caches lookups, honours overrides and falls back on errors', async () => {
    const show = vi.fn(async () => ({ model_info: { 'x.context_length': 4096 } }));
    const llm = new OllamaLLM({ show } as any);
    expect(await llm.contextWindow('m')).toBe(4096);
    expect(await llm.contextWindow('m')).toBe(4096);
    expect(show).toHaveBeenCalledTimes(1);
    expect(await new OllamaLLM({ show } as any, 1000).contextWindow('m')).toBe(1000);
    expect(await new OllamaLLM({ show: async () => Promise.reject(new Error('x')) } as any).contextWindow('m')).toBe(32768);
  });
});

describe('OllamaWeb', () => {
  it('searches through the Ollama web search API with snake_case max_results', async () => {
    const webSearch = vi.fn(async () => ({ results: [{ title: 'T', url: 'https://x.dev', content: 'C' }] }));
    const web = new OllamaWeb({ webSearch } as any, 'key');
    expect(await web.search('q', 3)).toEqual([{ title: 'T', url: 'https://x.dev', content: 'C' }]);
    expect(webSearch).toHaveBeenCalledWith({ query: 'q', max_results: 3 });
  });

  it('requires an API key for search', async () => {
    await expect(new OllamaWeb({} as any).search('q', 3)).rejects.toThrow(/OLLAMA_API_KEY/);
  });

  it('fetches via Ollama when keyed, else falls back to a direct fetch', async () => {
    const keyed = new OllamaWeb({ webFetch: async () => ({ title: 'T', url: 'https://a.dev', content: 'body', links: [] }) } as any, 'key');
    expect((await keyed.fetch('https://a.dev')).content).toBe('body');

    const fetchImpl = vi.fn(async () => new Response('<html><title>Job</title><body><h1>Role</h1><a href="https://apply.dev">x</a></body></html>', { status: 200 }));
    const direct = new OllamaWeb({} as any, undefined, fetchImpl as any);
    const page = await direct.fetch('https://jobs.dev/1');
    expect(page).toMatchObject({ title: 'Job', links: ['https://apply.dev'] });
    expect(page.content).toContain('Role');
  });

  it('refuses private and non-http URLs', async () => {
    const web = new OllamaWeb({} as any);
    await expect(web.fetch('http://localhost:4817/api/profile')).rejects.toThrow(/not allowed/);
    await expect(web.fetch('file:///etc/passwd')).rejects.toThrow(/http/);
  });
});

describe('assertPublicHttpUrl', () => {
  it.each(['http://127.0.0.1', 'http://10.0.0.1', 'http://192.168.1.1', 'http://172.20.0.1', 'http://169.254.169.254', 'http://[::1]', 'http://printer.local'])(
    'blocks %s',
    (url) => expect(() => assertPublicHttpUrl(url)).toThrow(),
  );
  it('allows public hosts', () => {
    expect(assertPublicHttpUrl('https://jobs.example.com/123').hostname).toBe('jobs.example.com');
    expect(() => assertPublicHttpUrl('not a url')).toThrow(/Invalid URL/);
  });
});
