import { describe, expect, it } from 'vitest';
import { renderInline, renderMarkdown, safeUrl } from '../../../web/src/markdown.ts';

describe('renderMarkdown', () => {
  it('escapes HTML so model output cannot inject markup', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> **<b>bold</b>**');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('<strong>&lt;b&gt;bold&lt;/b&gt;</strong>');
  });

  it('renders headings, paragraphs with line breaks, emphasis and code', () => {
    expect(renderMarkdown('## Title')).toBe('<h2>Title</h2>');
    expect(renderMarkdown('line one\nline *two* and `code`')).toBe('<p>line one<br>line <em>two</em> and <code>code</code></p>');
    expect(renderMarkdown('```js\nconst a = "<b>";\n```')).toBe('<pre><code>const a = &quot;&lt;b&gt;&quot;;</code></pre>');
    expect(renderInline('~~old~~ __new__ snake_case_name')).toBe('<del>old</del> <strong>new</strong> snake_case_name');
  });

  it('renders ordered, unordered, nested and task lists', () => {
    expect(renderMarkdown('- a\n- b')).toBe('<ul><li>a</li><li>b</li></ul>');
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('- a\n  - a1\n- b')).toBe('<ul><li>a<ul><li>a1</li></ul></li><li>b</li></ul>');
    expect(renderMarkdown('- [x] done\n- [ ] todo')).toContain('<input type="checkbox" disabled checked> done');
    expect(renderMarkdown('Intro:\n- a\n\nAfter')).toBe('<p>Intro:</p>\n<ul><li>a</li></ul>\n<p>After</p>');
  });

  it('renders tables, blockquotes and rules', () => {
    expect(renderMarkdown('| A | B |\n|---|---|\n| 1 | **2** |')).toBe('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td><strong>2</strong></td></tr></tbody></table>');
    expect(renderMarkdown('> quoted')).toBe('<blockquote><p>quoted</p></blockquote>');
    expect(renderMarkdown('---')).toBe('<hr>');
  });

  it('only links to safe URLs', () => {
    expect(renderInline('[PDF](/api/jobs/x/pdf?download=1&a=b)')).toBe('<a href="/api/jobs/x/pdf?download=1&amp;a=b">PDF</a>');
    expect(renderInline('[site](https://example.com)')).toContain('target="_blank" rel="noopener noreferrer"');
    expect(renderInline('[bad](javascript:alert(1))')).toBe('bad)');
    expect(renderInline('see https://example.com/x.')).toBe('see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>.');
    expect(safeUrl('//evil.com')).toBeNull();
    expect(safeUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
  });
});
