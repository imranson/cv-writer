import { describe, expect, it, vi } from 'vitest';
import { assertPublicUrl, isPrivateAddress, parseDuckDuckGo, webFetch, webSearch } from '../../src/lib/web.js';

const publicResolve = async () => ['93.184.216.34'];

describe('SSRF guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1'])(
    'treats %s as private',
    (ip) => expect(isPrivateAddress(ip)).toBe(true),
  );
  it.each(['8.8.8.8', '93.184.216.34', '2606:4700::1111'])('treats %s as public', (ip) => expect(isPrivateAddress(ip)).toBe(false));

  it('rejects non-http, localhost and private resolutions', async () => {
    await expect(assertPublicUrl('file:///etc/passwd')).rejects.toThrow(/Only http/);
    await expect(assertPublicUrl('http://localhost:3000')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://169.254.169.254/latest')).rejects.toThrow(/private/);
    await expect(assertPublicUrl('http://evil.test', async () => ['10.0.0.5'])).rejects.toThrow(/private/);
    await expect(assertPublicUrl('not a url')).rejects.toThrow(/Invalid URL/);
    await expect(assertPublicUrl('https://example.com/x', publicResolve)).resolves.toBeInstanceOf(URL);
  });
});

describe('webSearch', () => {
  it('uses the Ollama web search API when a key is set', async () => {
    const fetchImpl = vi.fn(async (_url: any, init: any) => {
      expect(init.headers.authorization).toBe('Bearer k');
      expect(JSON.parse(init.body)).toEqual({ query: 'acme', max_results: 2 });
      return new Response(JSON.stringify({ results: [{ title: 'Acme', url: 'https://acme.com', content: 'About Acme' }] }));
    });
    const res = await webSearch('acme', 2, { apiKey: 'k', fetchImpl: fetchImpl as any });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://ollama.com/api/web_search');
    expect(res).toEqual([{ title: 'Acme', url: 'https://acme.com', snippet: 'About Acme' }]);
  });

  it('falls back to DuckDuckGo HTML without a key', async () => {
    const html = `<div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Facme.com%2Fjobs&rut=x">Acme <b>Jobs</b></a>
      <a class="result__snippet" href="#">Careers at &amp; Acme</a></div>
      <div class="result"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>`;
    const fetchImpl = vi.fn(async () => new Response(html, { headers: { 'content-type': 'text/html' } }));
    const res = await webSearch('acme jobs', 5, { fetchImpl: fetchImpl as any });
    expect(String(fetchImpl.mock.calls[0][0])).toContain('html.duckduckgo.com/html/?q=acme%20jobs');
    expect(res).toEqual([{ title: 'Acme Jobs', url: 'https://acme.com/jobs', snippet: 'Careers at & Acme' }]);
  });

  it('parses an empty result page', () => {
    expect(parseDuckDuckGo('<html></html>')).toEqual([]);
  });
});

describe('webFetch', () => {
  it('fetches HTML, follows safe redirects and extracts text', async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url) === 'https://a.example/') return new Response(null, { status: 302, headers: { location: '/job' } });
      return new Response('<title>Job</title><p>Hello world</p>', { headers: { 'content-type': 'text/html' } });
    });
    const page = await webFetch('https://a.example/', { fetchImpl: fetchImpl as any, resolve: publicResolve });
    expect(page).toMatchObject({ url: 'https://a.example/job', title: 'Job', content: 'Hello world', truncated: false });
  });

  it('blocks redirects to private addresses', async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 301, headers: { location: 'http://127.0.0.1/admin' } }));
    await expect(webFetch('https://a.example/', { fetchImpl: fetchImpl as any, resolve: publicResolve })).rejects.toThrow(/private/);
  });

  it('truncates long content', async () => {
    const fetchImpl = vi.fn(async () => new Response('x'.repeat(5000), { headers: { 'content-type': 'text/plain' } }));
    const page = await webFetch('https://a.example/', { fetchImpl: fetchImpl as any, resolve: publicResolve, maxChars: 1000 });
    expect(page.content).toHaveLength(1000);
    expect(page.truncated).toBe(true);
  });

  it('falls back to Ollama web_fetch when direct fetch fails and a key is set', async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).startsWith('https://ollama.com/api/web_fetch')) {
        return new Response(JSON.stringify({ title: 'T', content: 'Fetched by Ollama' }));
      }
      return new Response('blocked', { status: 403 });
    });
    const page = await webFetch('https://a.example/', { fetchImpl: fetchImpl as any, resolve: publicResolve, apiKey: 'k' });
    expect(page.content).toBe('Fetched by Ollama');
  });
});
