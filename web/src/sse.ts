export interface SseMessage {
  event: string;
  data: string;
}

/** Parses one SSE block ("event: x\ndata: y") into a message; returns null for comments/keep-alives. */
export function parseSseBlock(block: string): SseMessage | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(':')) continue;
    const idx = line.indexOf(':');
    const field = idx < 0 ? line : line.slice(0, idx);
    const value = idx < 0 ? '' : line.slice(idx + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length ? { event, data: data.join('\n') } : null;
}

/** Reads a text/event-stream body (from a fetch POST, which EventSource cannot do). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(buffer.slice(idx).match(/^\r?\n\r?\n/)![0].length + idx);
      const msg = parseSseBlock(block);
      if (msg) yield msg;
    }
  }
  const tail = parseSseBlock(buffer + decoder.decode());
  if (tail) yield tail;
}
