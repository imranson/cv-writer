import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../../src/client/markdown.js';
import { createSseParser, readEventStream } from '../../src/client/sse.js';

describe('client markdown', () => {
  it('renders common formatting', () => {
    expect(renderMarkdown('Hello **Ada**, see `code` and *this*.')).toBe('<p>Hello <strong>Ada</strong>, see <code>code</code> and <em>this</em>.</p>');
    expect(renderMarkdown('- one\n- two\n\n1. first')).toBe('<ul><li>one</li><li>two</li></ul><ol><li>first</li></ol>');
    expect(renderMarkdown('## Title\nline1\nline2')).toBe('<h4>Title</h4><p>line1<br>line2</p>');
    expect(renderMarkdown('```\n<b>x</b>\n```')).toBe('<pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre>');
    expect(renderMarkdown('[site](https://a.dev)')).toContain('<a href="https://a.dev" target="_blank" rel="noopener noreferrer">site</a>');
  });

  it('never lets HTML or javascript: links through', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1))');
    expect(out).not.toContain('<img');
    expect(out).not.toContain('href="javascript');
  });
});

describe('client SSE parsing', () => {
  it('handles events split across chunks and CRLF separators', () => {
    const got: string[] = [];
    const parser = createSseParser((d) => got.push(d));
    parser.push('data: {"a":');
    parser.push('1}\n\ndata: two\r\n\r\n: comment\n\ndata: x\ndata: y\n\n');
    expect(got).toEqual(['{"a":1}', 'two', 'x\ny']);
  });

  it('reads a streamed response body', async () => {
    const body = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"delta"}\n\ndata: {"type":"do'));
        c.enqueue(new TextEncoder().encode('ne"}\n\n'));
        c.close();
      },
    });
    const events: unknown[] = [];
    await readEventStream(new Response(body), (e) => events.push(e));
    expect(events).toEqual([{ type: 'delta' }, { type: 'done' }]);
  });
});
