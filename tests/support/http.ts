import type { Hono } from 'hono';
import { readSse } from '../../web/src/sse.ts';

export function client(app: Hono) {
  const send = async (method: string, url: string, body?: unknown) => {
    const res = await app.request(url, {
      method,
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const type = res.headers.get('content-type') ?? '';
    const data = type.includes('json') ? await res.json() : type.includes('pdf') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    return { status: res.status, headers: res.headers, data: data as any };
  };
  return {
    get: (url: string) => send('GET', url),
    post: (url: string, body: unknown = {}) => send('POST', url, body),
    put: (url: string, body: unknown) => send('PUT', url, body),
    patch: (url: string, body: unknown) => send('PATCH', url, body),
    del: (url: string) => send('DELETE', url),
    /** POST a chat message and collect the streamed SSE events. */
    async chat(sessionId: string, text: string) {
      const res = await app.request(`/api/sessions/${sessionId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.body || !res.headers.get('content-type')?.includes('text/event-stream')) {
        return { status: res.status, events: [] as any[], body: await res.text() };
      }
      const events: any[] = [];
      for await (const m of readSse(res.body)) events.push({ ...JSON.parse(m.data), _event: m.event });
      return { status: res.status, events, body: '' };
    },
  };
}
