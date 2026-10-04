import { describe, expect, it } from 'vitest';
import {
  assertWebUrl,
  decodeEntities,
  directFetcher,
  firstWorking,
  htmlToText,
  MAX_PAGE_CHARS,
  ollamaWebFetcher,
} from '../../src/web/fetchPage.js';

const respond = (body: string, init: ResponseInit & { url?: string } = {}) =>
  (async () => {
    const res = new Response(body, init);
    if (init.url) Object.defineProperty(res, 'url', { value: init.url });
    return res;
  }) as unknown as typeof fetch;

describe('htmlToText', () => {
  it('keeps the readable text of a job page, one block per line', () => {
    const html = `<!doctype html><html><head><title>Engineer &amp; Co</title><style>p{}</style></head>
      <body><nav>Home</nav><script>track()</script><!-- hidden -->
      <h1>Graduate   Engineer</h1><p>Build <b>Python</b>&nbsp;services.</p>
      <ul><li>Python</li><li>AWS&#39;s Lambda</li></ul><p>Salary: &pound;30k&#x2014;&#8364;35k</p></body></html>`;
    expect(htmlToText(html)).toEqual({
      title: 'Engineer & Co',
      text: "Home\n\nGraduate Engineer\n\nBuild Python services.\n\n- Python\n\n- AWS's Lambda\n\nSalary: &pound;30k—€35k",
    });
  });

  it('decodes numeric and named entities, leaving unknown ones alone', () => {
    expect(decodeEntities('&lt;a&gt; &#65;&#x42; &rsquo; &bogus; &#0;')).toBe('<a> AB ’ &bogus; &#0;');
  });
});

describe('assertWebUrl', () => {
  it('accepts http(s) only', () => {
    expect(assertWebUrl('https://jobs.example/1').hostname).toBe('jobs.example');
    expect(() => assertWebUrl('file:///etc/passwd')).toThrow(/Only http\(s\)/);
    expect(() => assertWebUrl('not a url')).toThrow(/not a valid URL/);
  });
});

describe('directFetcher', () => {
  it('turns HTML pages into text', async () => {
    const fetcher = directFetcher(respond('<title>Job</title><p>We need Go.</p>', { headers: { 'content-type': 'text/html' }, url: 'https://final.example/job' }));
    expect(await fetcher('https://jobs.example/1')).toEqual({ url: 'https://final.example/job', title: 'Job', text: 'We need Go.' });
  });

  it('passes plain text through and truncates very long pages', async () => {
    const fetcher = directFetcher(respond('x'.repeat(MAX_PAGE_CHARS + 10), { headers: { 'content-type': 'text/plain' } }));
    const page = await fetcher('https://jobs.example/1');
    expect(page.text).toMatch(/\[… page truncated at 30000 characters\]$/);
    expect(page).not.toHaveProperty('title');
  });

  it('fails on HTTP errors and on pages with no readable text', async () => {
    await expect(directFetcher(respond('nope', { status: 403 }))('https://jobs.example/1')).rejects.toThrow('The page returned HTTP 403');
    await expect(directFetcher(respond('<html><script>app()</script></html>'))('https://jobs.example/1')).rejects.toThrow(/needs? JavaScript/);
    await expect(directFetcher(respond(''))('ftp://x')).rejects.toThrow(/Only http/);
  });
});

describe('ollamaWebFetcher / firstWorking', () => {
  it('uses Ollama web fetch results', async () => {
    const fetcher = ollamaWebFetcher({ webFetch: async ({ url }) => ({ url, title: 'T', content: ' text ', links: [] }) });
    expect(await fetcher('https://a.example')).toEqual({ url: 'https://a.example', title: 'T', text: 'text' });
    const empty = ollamaWebFetcher({ webFetch: async ({ url }) => ({ url, title: '', content: '', links: [] }) });
    await expect(empty('https://a.example')).rejects.toThrow(/no content/);
  });

  it('falls back to the next fetcher and reports every failure if all fail', async () => {
    const fail = (msg: string) => async () => {
      throw new Error(msg);
    };
    const ok = async (url: string) => ({ url, text: 'found' });
    expect(await firstWorking(fail('a'), ok)('https://x.example')).toEqual({ url: 'https://x.example', text: 'found' });
    await expect(firstWorking(fail('a'), fail('b'))('https://x.example')).rejects.toThrow('Could not fetch https://x.example: a; b');
  });
});
