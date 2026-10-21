import { describe, expect, it } from 'vitest';
import { applyTextEdits, escapeHtml, htmlToText, sanitizeHtml, truncate } from '../../src/util/text';

describe('applyTextEdits', () => {
  it('applies unique replacements in order', () => {
    expect(applyTextEdits('<h1>Old</h1><p>Old text</p>', [{ find: '<h1>Old', replace: '<h1>New' }, { find: 'Old text', replace: 'Fresh' }])).toBe(
      '<h1>New</h1><p>Fresh</p>',
    );
  });
  it('requires all=true for ambiguous matches', () => {
    expect(() => applyTextEdits('a a', [{ find: 'a', replace: 'b' }])).toThrow(/occurs 2 times/);
    expect(applyTextEdits('a a', [{ find: 'a', replace: 'b', all: true }])).toBe('b b');
  });
  it('reports missing text and empty finds', () => {
    expect(() => applyTextEdits('abc', [{ find: 'zzz', replace: '' }])).toThrow(/not found/);
    expect(() => applyTextEdits('abc', [{ find: '', replace: 'x' }])).toThrow(/must not be empty/);
  });
  it('does not interpret $ patterns in replacements', () => {
    expect(applyTextEdits('price', [{ find: 'price', replace: '$& $1' }])).toBe('$& $1');
  });
});

describe('sanitizeHtml', () => {
  it('strips scripts, event handlers, embeds and javascript: URLs', () => {
    const dirty = '<p onclick="steal()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><iframe src="x"></iframe><img src=x onerror=alert(1)>';
    const clean = sanitizeHtml(dirty);
    expect(clean).not.toMatch(/script|onclick|onerror|javascript:|iframe/i);
    expect(clean).toContain('<p>Hi</p>');
  });
  it('leaves normal CV markup untouched', () => {
    const html = '<section id="experience"><h2>Experience</h2><a href="https://x.dev">x.dev</a></section>';
    expect(sanitizeHtml(html)).toBe(html);
  });
});

describe('htmlToText / truncate / escapeHtml', () => {
  it('converts html to readable text', () => {
    expect(htmlToText('<style>x{}</style><h1>Title</h1><p>A &amp; B</p><script>no()</script>')).toBe('Title\n A & B');
  });
  it('truncates with a marker', () => {
    expect(truncate('abcdef', 3)).toBe('abc… [truncated 3 chars]');
    expect(truncate('abc', 3)).toBe('abc');
  });
  it('escapes html', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});
