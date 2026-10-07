import type { AddressInfo } from 'node:net';
import { createApp, type ServerOptions } from '../../src/server/app.js';
import { readSse, type SseMessage } from '../../web/src/sse.js';

export async function startServer(options: ServerOptions): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createApp(options);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export async function getJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

export async function send(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(url, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

/** Posts to a streaming endpoint and collects every event until the stream ends. */
export async function converse(url: string, body?: unknown): Promise<{ events: SseMessage[]; reply?: string; error?: string }> {
  const res = await send('POST', url, body ?? {});
  if (!res.ok) throw new Error(`${url} → ${res.status} ${await res.text()}`);
  const events: SseMessage[] = [];
  for await (const m of readSse(res.body!)) events.push(m);
  const reply = events.find((e) => e.event === 'reply')?.data as { text: string } | undefined;
  const error = events.find((e) => e.event === 'error')?.data as { message: string } | undefined;
  return { events, ...(reply ? { reply: reply.text } : {}), ...(error ? { error: error.message } : {}) };
}
