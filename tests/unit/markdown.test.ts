import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/client/markdown.js';

describe('chat markdown renderer', () => {
  it('escapes HTML before formatting', () => {
    expect(renderMarkdown('<img src=x onerror=alert(1)> **bold**')).toBe('<p>&lt;img src=x onerror=alert(1)&gt; <strong>bold</strong></p>');
  });

  it('renders lists, headings, code, quotes and safe links only', () => {
    const html = renderMarkdown('## Title\n- one\n- *two*\n\n1. a\n2. b\n\n```\n<x>\n```\n> quote\n[ok](https://a.example) [bad](javascript:alert(1)) `code`');
    expect(html).toContain('<h4>Title</h4>');
    expect(html).toContain('<ul><li>one</li><li><em>two</em></li></ul>');
    expect(html).toContain('<ol><li>a</li><li>b</li></ol>');
    expect(html).toContain('<pre><code>&lt;x&gt;</code></pre>');
    expect(html).toContain('<blockquote>quote</blockquote>');
    expect(html).toContain('<a href="https://a.example" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(html).not.toContain('href="javascript');
    expect(html).toContain('<code>code</code>');
  });

  it('keeps line breaks inside paragraphs', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>');
  });
});
