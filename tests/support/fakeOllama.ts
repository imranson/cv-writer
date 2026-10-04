import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: any;
}

/** What the fake server sends back: a chat message, or an HTTP error. */
export type FakeResponse =
  | { message: Record<string, unknown>; prompt_eval_count?: number; eval_count?: number }
  | { status: number; error: string };

export type FakeHandler = (body: any, request: RecordedRequest) => FakeResponse | Promise<FakeResponse>;

/**
 * A minimal Ollama HTTP server (POST /api/chat, non-streaming) so the real ollama-js
 * client, and the real CLI, can be exercised over the wire without a model.
 */
export async function startFakeOllama(handler: FakeHandler | FakeResponse[]) {
  const requests: RecordedRequest[] = [];
  const queue = Array.isArray(handler) ? [...handler] : undefined;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', async () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
        body: raw ? JSON.parse(raw) : undefined,
      };
      requests.push(recorded);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (recorded.path !== '/api/chat' || recorded.method !== 'POST') return send(404, { error: 'not found' });
      try {
        const out = queue ? queue.shift() : await (handler as FakeHandler)(recorded.body, recorded);
        if (!out) return send(500, { error: 'fake server: no scripted response left' });
        if ('status' in out) return send(out.status, { error: out.error });
        send(200, {
          model: recorded.body.model,
          created_at: new Date().toISOString(),
          message: { role: 'assistant', content: '', ...out.message },
          done: true,
          done_reason: 'stop',
          prompt_eval_count: out.prompt_eval_count ?? 50,
          eval_count: out.eval_count ?? 10,
        });
      } catch (err) {
        send(500, { error: (err as Error).message });
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
