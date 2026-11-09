import type { AgentEvent } from '../shared/events.js';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const HEADERS = { 'content-type': 'application/json', 'x-cvw': '1' };

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: HEADERS,
    credentials: 'same-origin',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new ApiError(res.status, json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

/** Reads an SSE response produced by the chat endpoints, calling onEvent for each event. */
export async function streamEvents(
  url: string,
  init: { method: string; body?: unknown; signal?: AbortSignal },
  onEvent: (e: AgentEvent) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: init.method,
    headers: HEADERS,
    credentials: 'same-origin',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: init.signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try {
      msg = JSON.parse(text).error ?? msg;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch (err) {
          console.warn('bad event', err);
        }
      }
    }
  }
}
