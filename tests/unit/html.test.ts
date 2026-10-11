import { describe, expect, it } from 'vitest';
import { decodeEntities, escapeHtml, extractTitle, htmlToText } from '../../src/lib/html.js';

describe('html helpers', () => {
  it('converts HTML to readable text', () => {
    const html = `<html><head><title>Job &amp; Co</title><style>p{}</style></head><body>
      <script>alert(1)</script><h1>Senior&nbsp;Engineer</h1><p>Build <b>things</b>.</p><ul><li>TypeScript</li><li>Node</li></ul></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain('Senior Engineer');
    expect(text).toContain('Build things.');
    expect(text).toContain('• TypeScript');
    expect(text).not.toContain('alert');
    expect(text).not.toContain('p{}');
    expect(extractTitle(html)).toBe('Job & Co');
  });
  it('decodes numeric entities and escapes HTML', () => {
    expect(decodeEntities('&#8364;5 &#x2014; &unknown;')).toBe('€5 — &unknown;');
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
