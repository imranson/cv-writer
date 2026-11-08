import type { AgentEvent } from '../agents/events.js';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: method === 'GET' ? {} : { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
  if (!res.ok) throw new ApiError(data?.error ?? `${res.status} ${res.statusText}`, res.status);
  return data as T;
}

/** Parses a text/event-stream response body and calls `onEvent` for each JSON event. */
export async function readEventStream(res: Response, onEvent: (e: AgentEvent) => void): Promise<void> {
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(data.error ?? `${res.status} ${res.statusText}`, res.status);
  }
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.search(/\r?\n\r?\n/)) >= 0) {
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).replace(/^ /, ''))
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        /* ignore malformed event */
      }
    }
  }
}

export function sendMessage(sessionId: string, content: string): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ content, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
  });
}

export function attachStream(sessionId: string): Promise<Response> {
  return fetch(`/api/sessions/${sessionId}/stream`, { credentials: 'same-origin', headers: { accept: 'text/event-stream' } });
}
