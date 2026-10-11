import { describe, expect, it } from 'vitest';
import { parseSseBlock, readSse } from '../../../web/src/sse.ts';

function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
}

describe('SSE parsing', () => {
  it('parses event and multi-line data fields, ignoring comments', () => {
    expect(parseSseBlock('event: text\ndata: {"a":1}')).toEqual({ event: 'text', data: '{"a":1}' });
    expect(parseSseBlock('data: line1\ndata: line2')).toEqual({ event: 'message', data: 'line1\nline2' });
    expect(parseSseBlock(': keep-alive')).toBeNull();
  });

  it('reassembles messages split across chunks, including multi-byte characters', async () => {
    const out = [];
    const bytes = new TextEncoder().encode('event: text\ndata: "café"\n\n');
    const split = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 22));
        c.enqueue(bytes.slice(22));
        c.close();
      },
    });
    for await (const m of readSse(split)) out.push(m);
    expect(out).toEqual([{ event: 'text', data: '"café"' }]);

    const all = [];
    for await (const m of readSse(streamOf('event: a\r\ndata: 1\r\n\r\nevent: b\nda', 'ta: 2\n\nevent: c\ndata: 3'))) all.push(m);
    expect(all).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
      { event: 'c', data: '3' },
    ]);
  });
});
