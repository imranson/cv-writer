import { describe, expect, it, vi } from 'vitest';
import { createWebClient, isOllamaCloud } from '../../src/lib/web.js';

const publicResolver = async () => ['93.184.216.34'];

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('web search / web fetch client', () => {
  it('detects ollama.com', () => {
    expect(isOllamaCloud('https://ollama.com')).toBe(true);
    expect(isOllamaCloud('http://localhost:11434')).toBe(false);
  });

  it('uses /api/web_search with a bearer key on ollama.com', async () => {
    const fetchImpl = vi.fn(async (_url: any, _init?: any) =>
      jsonResponse({ results: [{ title: 'T', url: 'https://a.example', content: 'x'.repeat(5000) }] }),
    );
    const web = createWebClient({ host: 'https://ollama.com', apiKey: 'k', fetchImpl: fetchImpl as any, resolver: publicResolver });
    const results = await web.search('cv tips', 20);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ollama.com/api/web_search');
    expect(init.headers.authorization).toBe('Bearer k');
    expect(JSON.parse(init.body)).toEqual({ query: 'cv tips', max_results: 10 });
    expect(results[0].content).toHaveLength(1500);
  });

  it('uses the experimental endpoints on a local daemon', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ title: 'Job', content: 'Requirements', links: ['https://x'] }));
    const web = createWebClient({ host: 'http://localhost:11434', fetchImpl: fetchImpl as any, resolver: publicResolver });
    const page = await web.fetch('https://jobs.example/1');
    expect((fetchImpl.mock.calls[0] as any[])[0]).toBe('http://localhost:11434/api/experimental/web_fetch');
    expect(page).toMatchObject({ title: 'Job', content: 'Requirements', source: 'ollama' });
  });

  it('falls back to a guarded direct fetch and extracts text', async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).includes('web_fetch')) return jsonResponse({ error: 'unauthorized' }, 401);
      return new Response('<html><title>Advert</title><body><p>Python &amp; AWS</p></body></html>', {
        headers: { 'content-type': 'text/html' },
      });
    });
    const web = createWebClient({ host: 'https://ollama.com', fetchImpl: fetchImpl as any, resolver: publicResolver });
    const page = await web.fetch('https://jobs.example/1');
    expect(page).toMatchObject({ title: 'Advert', content: 'Python & AWS', source: 'direct' });
  });

  it('refuses private targets before calling anything', async () => {
    const fetchImpl = vi.fn();
    const web = createWebClient({ host: 'https://ollama.com', fetchImpl: fetchImpl as any, resolver: async () => ['10.0.0.1'] });
    await expect(web.fetch('https://intranet.example')).rejects.toThrow('private');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('re-checks redirects in direct mode', async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).includes('web_fetch')) throw new Error('down');
      return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } });
    });
    const web = createWebClient({ host: 'https://ollama.com', fetchImpl: fetchImpl as any, resolver: publicResolver });
    await expect(web.fetch('https://jobs.example/1')).rejects.toThrow('private');
  });
});
