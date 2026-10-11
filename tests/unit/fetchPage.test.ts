import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl, extractMainText, fetchPage, FetchPageError } from '../../src/util/fetchPage.ts';

const respond = (body: string, init: ResponseInit & { url?: string } = {}) =>
  (async () => {
    const res = new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' }, ...init });
    return res;
  }) as unknown as typeof fetch;

describe('fetchPage', () => {
  it('refuses non-http and private addresses', () => {
    expect(() => assertPublicHttpUrl('file:///etc/passwd')).toThrow(FetchPageError);
    for (const u of ['http://localhost:3000', 'http://127.0.0.1', 'http://10.0.0.5', 'http://192.168.1.1', 'http://172.20.0.1', 'http://[::1]/']) {
      expect(() => assertPublicHttpUrl(u)).toThrow(/private or local/);
    }
    expect(() => assertPublicHttpUrl('not a url')).toThrow(/Not a valid URL/);
    expect(assertPublicHttpUrl('https://jobs.example.com/1').hostname).toBe('jobs.example.com');
    expect(assertPublicHttpUrl('http://localhost', true).hostname).toBe('localhost');
  });

  it('extracts the main content of an HTML page', async () => {
    const html = `<html><head><title>Senior PM &amp; Lead</title><script>x</script></head><body><nav>Menu</nav><main><h1>Senior PM</h1><p>${'Own the roadmap. '.repeat(30)}</p><ul><li>SQL</li></ul></main><footer>© Co</footer></body></html>`;
    const page = await fetchPage('https://jobs.example.com/1', { fetch: respond(html) });
    expect(page.title).toBe('Senior PM & Lead');
    expect(page.text).toContain('# Senior PM');
    expect(page.text).toContain('- SQL');
    expect(page.text).not.toContain('Menu');
    expect(page.text).not.toContain('© Co');
  });

  it('returns plain text as-is and truncates long pages', async () => {
    const page = await fetchPage('https://x.example/job.txt', { fetch: respond('a'.repeat(50), { headers: { 'Content-Type': 'text/plain' } }), maxChars: 10 });
    expect(page.text).toMatch(/^a{10}\n…\[truncated 40 characters\]$/);
  });

  it('reports HTTP errors, network errors and unsupported content', async () => {
    await expect(fetchPage('https://x.example', { fetch: respond('', { status: 404 }) })).rejects.toThrow(/HTTP 404/);
    await expect(fetchPage('https://x.example', { fetch: respond('{}', { headers: { 'Content-Type': 'application/pdf' } }) })).rejects.toThrow(/Unsupported content type/);
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(fetchPage('https://x.example', { fetch: failing })).rejects.toThrow(/Could not fetch.*ECONNREFUSED/);
  });

  it('falls back to the whole body when <main> is tiny', () => {
    const { text } = extractMainText('<body><main>x</main><div>Real listing content here</div></body>');
    expect(text).toContain('Real listing content here');
  });
});
