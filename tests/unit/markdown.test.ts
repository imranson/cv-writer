import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/shared/markdown.js';

describe('renderMarkdown', () => {
  it('escapes raw HTML', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('renders lists, headings, code and quotes', () => {
    const out = renderMarkdown('## Plan\n1. First\n2. Second\n\n- a\n- b *c*\n\n```\n<x>\n```\n> note\n\nInline `code` here');
    expect(out).toContain('<h4>Plan</h4>');
    expect(out).toContain('<ol><li>First</li><li>Second</li></ol>');
    expect(out).toContain('<ul><li>a</li><li>b <em>c</em></li></ul>');
    expect(out).toContain('<pre><code>&lt;x&gt;</code></pre>');
    expect(out).toContain('<blockquote>note</blockquote>');
    expect(out).toContain('<code>code</code>');
  });

  it('only links safe URLs', () => {
    expect(renderMarkdown('[ok](https://a.com)')).toContain('<a href="https://a.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(renderMarkdown('[bad](javascript:alert(1))')).not.toContain('<a ');
  });

  it('keeps line breaks within paragraphs', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>');
  });
});
