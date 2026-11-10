import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/shared/markdown.js';

const flat = (s: string) => renderMarkdown(s).replace(/\n/g, '');

describe('renderMarkdown', () => {
  it('escapes raw HTML (inline and block)', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> **bold**');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
    expect(out).toContain('<strong>bold</strong>');
    const block = renderMarkdown('<div onclick="x">\nhi\n</div>\n\n<script>alert(1)</script>');
    expect(block).not.toMatch(/<(div|script)\b/);
    expect(block).toContain('&lt;script&gt;');
  });

  it('renders lists, headings, code and quotes', () => {
    const out = flat('## Plan\n1. First\n2. Second\n\n- a\n- b *c*\n\n```\n<x>\n```\n> note\n\nInline `code` here');
    expect(out).toContain('<h4>Plan</h4>');
    expect(out).toContain('<ol><li>First</li><li>Second</li></ol>');
    expect(out).toContain('<ul><li>a</li><li>b <em>c</em></li></ul>');
    expect(out).toContain('<pre><code>&lt;x&gt;</code></pre>');
    expect(out).toContain('<blockquote><p>note</p></blockquote>');
    expect(out).toContain('<code>code</code>');
  });

  it('renders GFM tables', () => {
    const out = flat('| Area | Status |\n|---|---|\n| Skills | **weak** |');
    expect(out).toContain('<table><thead><tr><th>Area</th><th>Status</th></tr></thead>');
    expect(out).toContain('<td><strong>weak</strong></td>');
  });

  it('keeps loose numbered lists in one list and nests sub-lists', () => {
    expect(flat('1. One\n\n2. Two\n\n3. Three').match(/<ol>/g)).toHaveLength(1);
    expect(flat('1. **Step**\n   - sub a\n   - sub b\n2. Next')).toBe(
      '<ol><li><strong>Step</strong><ul><li>sub a</li><li>sub b</li></ul></li><li>Next</li></ol>',
    );
  });

  it('handles nested emphasis and indented fences', () => {
    expect(renderMarkdown('**Bold *nested* item**')).toBe('<p><strong>Bold <em>nested</em> item</strong></p>');
    expect(renderMarkdown('   ```html\n<b>x</b>\n   ```')).toContain('<pre><code class="language-html">&lt;b&gt;x&lt;/b&gt;');
  });

  it('only links safe URLs', () => {
    expect(renderMarkdown('[ok](https://a.com)')).toContain('<a href="https://a.com" target="_blank" rel="noopener noreferrer">ok</a>');
    expect(renderMarkdown('see https://a.com/x')).toContain('<a href="https://a.com/x"');
    for (const bad of ['[bad](javascript:alert(1))', '[bad](JaVaScRiPt:alert(1))', '![bad](javascript:alert(1))', '[bad](data:text/html,x)', '<javascript:alert(1)>']) {
      expect(renderMarkdown(bad)).not.toContain('<a ');
    }
    expect(renderMarkdown('[x](https://a.com "t\\" onmouseover=\\"y")')).not.toMatch(/"\s+onmouseover=/);
  });

  it('keeps line breaks within paragraphs', () => {
    expect(renderMarkdown('a\nb\n\nc')).toBe('<p>a<br>b</p>\n<p>c</p>');
  });
});
