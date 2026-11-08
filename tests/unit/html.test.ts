import { describe, expect, it } from 'vitest';
import { buildCvDocument, decodeEntities, escapeHtml, htmlToText, sanitizeCvHtml } from '../../src/lib/html.js';

describe('html helpers', () => {
  it('converts pages to readable text', () => {
    const { title, text } = htmlToText(
      '<html><head><title>Job &amp; Co</title><style>p{}</style></head><body><script>x()</script><h1>Hiring</h1><ul><li>Python</li><li>AWS</li></ul><p>Apply&nbsp;now &#8212; today</p></body></html>',
    );
    expect(title).toBe('Job & Co');
    expect(text).toBe('Hiring\n\n• Python\n• AWS\n\nApply now — today');
  });

  it('decodes and escapes entities', () => {
    expect(decodeEntities('&lt;b&gt; &#x41; &unknown;')).toBe('<b> A &unknown;');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });

  it('strips active content from CV HTML', () => {
    const dirty = `<!doctype html><html><head><style>x</style></head><body><h1 onclick="steal()">Ann</h1><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="//evil"></iframe><p>ok</p></body></html>`;
    const clean = sanitizeCvHtml(dirty);
    expect(clean).toBe('<h1>Ann</h1><a href="#">x</a><p>ok</p>');
  });

  it('builds a standalone printable document', () => {
    const doc = buildCvDocument('<h1>Ann</h1>', 'h1{color:red}</style><script>', { title: 'CV <x>', lang: 'en-GB' });
    expect(doc).toContain('<html lang="en-GB">');
    expect(doc).toContain('<title>CV &lt;x&gt;</title>');
    expect(doc).toContain('h1{color:red}<\\/style><script>');
    expect(doc).toContain('<body>\n<h1>Ann</h1>');
    expect(buildCvDocument('', '', { lang: '"><script>' })).toContain('<html lang="en">');
    expect(buildCvDocument('', '')).toContain('not been written yet');
  });
});
