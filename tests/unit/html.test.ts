import { describe, expect, it } from 'vitest';
import { buildCvDocument, countWords, decodeEntities, escapeHtml, extractBody, htmlToText, sanitizeCvHtml } from '../../src/lib/html.js';

describe('htmlToText', () => {
  it('extracts title, readable text and absolute links', () => {
    const page = htmlToText(
      `<html><head><title>Senior Engineer &amp; Lead</title><style>.x{}</style></head>
       <body><script>alert(1)</script><h1>Role</h1><p>Build <b>things</b>.</p>
       <ul><li>Go</li><li>AWS</li></ul><a href="/apply">Apply now</a></body></html>`,
      'https://jobs.example.com/x',
    );
    expect(page.title).toBe('Senior Engineer & Lead');
    expect(page.text).toContain('# Role');
    expect(page.text).toContain('Build things.');
    expect(page.text).toContain('- Go');
    expect(page.text).not.toContain('alert');
    expect(page.links).toEqual([{ text: 'Apply now', url: 'https://jobs.example.com/apply' }]);
  });

  it('decodes entities', () => {
    expect(decodeEntities('&lt;a&gt; &#39;x&#39; &#x2014; &nbsp;')).toBe("<a> 'x' —  ".replace(' ', ' '));
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

describe('sanitizeCvHtml', () => {
  it('removes scripts, iframes, event handlers and javascript: URLs', () => {
    const dirty = `<h1 onclick="steal()">Ada</h1><script>alert(1)</script><iframe src="x"></iframe>
      <a href="javascript:alert(1)">x</a><img src=x onerror=alert(1)><form action="/x"><p>keep</p></form>`;
    const clean = sanitizeCvHtml(dirty);
    expect(clean).not.toMatch(/script|iframe|onclick|onerror|javascript:|<form/i);
    expect(clean).toContain('<h1>Ada</h1>');
    expect(clean).toContain('<p>keep</p>');
  });
});

describe('CV document assembly', () => {
  it('extracts body content from full documents', () => {
    expect(extractBody('<!doctype html><html><head><title>t</title></head><body><p>Hi</p></body></html>')).toBe('<p>Hi</p>');
    expect(extractBody('<html><p>frag</p></html>')).toBe('<p>frag</p>');
  });

  it('builds a standalone document with inline CSS and placeholder when empty', () => {
    const doc = buildCvDocument('<h1>Ada</h1>', 'h1{color:red}', 'My <CV>');
    expect(doc).toMatch(/^<!doctype html>/);
    expect(doc).toContain('<style>h1{color:red}</style>');
    expect(doc).toContain('<title>My &lt;CV&gt;</title>');
    expect(buildCvDocument('', '')).toContain('No CV yet');
    expect(buildCvDocument('<p>x</p>', 'a{}</style><script>')).not.toContain('</style><script>');
  });

  it('counts words', () => {
    expect(countWords('<h1>Ada Lovelace</h1><p>First programmer.</p>')).toBe(4);
    expect(countWords('')).toBe(0);
  });
});
