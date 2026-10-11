/** Incremental Server-Sent Events parser: feed text chunks, get each event's `data` payload. */
export function createSseParser(onData: (data: string) => void) {
  let buffer = '';
  return {
    push(chunk: string): void {
      buffer += chunk;
      for (let m = /\r?\n\r?\n/.exec(buffer); m; m = /\r?\n\r?\n/.exec(buffer)) {
        const block = buffer.slice(0, m.index);
        buffer = buffer.slice(m.index + m[0].length);
        const data = block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (data) onData(data);
      }
    },
  };
}

/** Reads an SSE response body to the end, calling `onEvent` with each parsed JSON event. */
export async function readEventStream<T>(response: Response, onEvent: (event: T) => void): Promise<void> {
  if (!response.body) return;
  const parser = createSseParser((data) => onEvent(JSON.parse(data) as T));
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(value);
  }
}
