export interface SSEMessage {
  event: string;
  data: string;
}

/** Incremental parser for `text/event-stream` bodies read through fetch(). */
export function createSSEParser(onMessage: (msg: SSEMessage) => void) {
  let buffer = '';
  const flush = (block: string) => {
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue;
      const idx = line.indexOf(':');
      const field = idx === -1 ? line : line.slice(0, idx);
      const value = idx === -1 ? '' : line.slice(idx + 1).replace(/^ /, '');
      if (field === 'event') event = value;
      else if (field === 'data') data.push(value);
    }
    if (data.length) onMessage({ event, data: data.join('\n') });
  };
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n?/g, '\n');
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (block.trim()) flush(block);
      }
    },
    end() {
      if (buffer.trim()) flush(buffer);
      buffer = '';
    },
  };
}
