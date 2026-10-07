export interface SseMessage {
  event: string;
  data: unknown;
}

/** Splits a server-sent-events buffer into complete messages and the unfinished remainder. */
export function parseSse(buffer: string): { messages: SseMessage[]; rest: string } {
  const messages: SseMessage[] = [];
  const blocks = buffer.replace(/\r\n/g, '\n').split('\n\n');
  const rest = blocks.pop() ?? '';
  for (const block of blocks) {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
    }
    if (!data.length) continue;
    const raw = data.join('\n');
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // plain text data
    }
    messages.push({ event, data: parsed });
  }
  return { messages, rest };
}

/** Reads an event stream from a fetch response body (EventSource cannot POST). */
export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseMessage> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { messages, rest } = parseSse(buffer);
    buffer = rest;
    yield* messages;
  }
  const { messages } = parseSse(`${buffer}\n\n`);
  yield* messages;
}
