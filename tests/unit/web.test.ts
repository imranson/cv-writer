import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../web/src/markdown.js';
import { parseSse, readSse } from '../../web/src/sse.js';

describe('parseSse', () => {
  it('parses complete events and keeps the remainder', () => {
    const { messages, rest } = parseSse('event: delta\ndata: {"content":"Hi"}\n\nevent: reply\ndata: {"text":"Hi there"}\n\nevent: do');
    expect(messages).toEqual([
      { event: 'delta', data: { content: 'Hi' } },
      { event: 'reply', data: { text: 'Hi there' } },
    ]);
    expect(rest).toBe('event: do');
  });

  it('handles CRLF, multi-line and non-JSON data, and skips comments', () => {
    const { messages } = parseSse(': keepalive\r\n\r\ndata: line one\r\ndata: line two\r\n\r\n');
    expect(messages).toEqual([{ event: 'message', data: 'line one\nline two' }]);
  });

  it('reads a byte stream split at arbitrary points', async () => {
    const text = 'event: a\ndata: {"n":1}\n\nevent: b\ndata: {"n":2}\n\n';
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < bytes.length; i += 7) c.enqueue(bytes.slice(i, i + 7));
        c.close();
      },
    });
    const out = [];
    for await (const m of readSse(body)) out.push(m);
    expect(out).toEqual([{ event: 'a', data: { n: 1 } }, { event: 'b', data: { n: 2 } }]);
  });
});

describe('chat markdown', () => {
  it('renders the common subset', () => {
    expect(renderMarkdown('**v2** scored *82*.\n\n- one\n- `two`\n\n1. first\n2. second')).toBe(
      '<p><strong>v2</strong> scored <em>82</em>.</p><ul><li>one</li><li><code>two</code></li></ul><ol><li>first</li><li>second</li></ol>',
    );
    expect(renderMarkdown('### Next\nline a\nline b')).toBe('<h4>Next</h4><p>line a<br>line b</p>');
    expect(renderMarkdown('[docs](https://x.example)')).toContain('<a href="https://x.example" target="_blank" rel="noopener">docs</a>');
  });

  it('never lets model output inject HTML', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('href="javascript');
  });
});

describe('chat markdown tables', () => {
  it('renders a pipe table and leaves stray pipes alone', () => {
    const html = renderMarkdown('Fit check:\n\n| Requirement | Evidence |\n|---|---|\n| **SQL** | ✅ reports |\n| Power BI | ⚠️ none |\n\nNext?');
    expect(html).toBe(
      '<p>Fit check:</p><table><thead><tr><th>Requirement</th><th>Evidence</th></tr></thead><tbody><tr><td><strong>SQL</strong></td><td>✅ reports</td></tr><tr><td>Power BI</td><td>⚠️ none</td></tr></tbody></table><p>Next?</p>',
    );
    expect(renderMarkdown('a | b')).toBe('<p>a | b</p>');
  });
});
