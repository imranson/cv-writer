import { describe, expect, it } from 'vitest';
import { decodeEntities, fetchPage, findJobPosting, htmlToText } from '../../src/util/fetchPage.js';

const page = (body: string, status = 200) => (async () => new Response(body, { status, headers: { 'Content-Type': 'text/html' } })) as unknown as typeof fetch;

describe('htmlToText', () => {
  it('keeps structure and drops chrome', () => {
    const text = htmlToText('<html><head><style>x{}</style><script>bad()</script></head><body><nav>Menu</nav><h1>Engineer</h1><p>We &amp; you&nbsp;&#8212; together</p><ul><li>Python</li><li>AWS</li></ul></body></html>');
    expect(text).toBe('Engineer\nWe & you — together\n\n- Python\n- AWS');
    expect(decodeEntities('&#x41;&lt;&unknown;')).toBe('A<&unknown;');
  });
});

describe('findJobPosting', () => {
  it('finds a schema.org JobPosting, including inside @graph', () => {
    const html = `<script type="application/ld+json">{"@graph":[{"@type":"Organization"},{"@type":"JobPosting","title":"SRE","description":"<p>Run things</p>"}]}</script>`;
    expect(findJobPosting(html)?.title).toBe('SRE');
    expect(findJobPosting('<script type="application/ld+json">{bad</script>')).toBeUndefined();
  });
});

describe('fetchPage', () => {
  it('prefers the structured job posting', async () => {
    const html = `<title>Jobs</title><script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Platform Engineer', hiringOrganization: { name: 'Babbage' }, jobLocation: { address: { addressLocality: 'London' } }, description: '&lt;p&gt;Build the platform&lt;/p&gt;&lt;ul&gt;&lt;li&gt;Go&lt;/li&gt;&lt;/ul&gt;' })}</script>`;
    const r = await fetchPage('https://jobs.example/1', page(html));
    expect(r).toEqual({ url: 'https://jobs.example/1', title: 'Platform Engineer', company: 'Babbage', location: 'London', text: 'Build the platform\n\n- Go' });
  });

  it('falls back to page text, and explains failures', async () => {
    const long = `<title>Role</title><p>${'Responsibilities include things. '.repeat(10)}</p>`;
    expect((await fetchPage('https://x.example', page(long))).title).toBe('Role');
    await expect(fetchPage('https://x.example', page('<p>Login</p>'))).rejects.toThrow(/almost no readable text/);
    await expect(fetchPage('https://x.example', page('', 403))).rejects.toThrow(/HTTP 403/);
    await expect(fetchPage('file:///etc/passwd', page(''))).rejects.toThrow(/Only http/);
    await expect(fetchPage('not a url', page(''))).rejects.toThrow(/not a valid URL/);
  });
});
