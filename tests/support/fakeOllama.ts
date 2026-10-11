import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface OllamaChatBody {
  model: string;
  messages: { role: string; content: string; tool_calls?: unknown[]; tool_name?: string; thinking?: string }[];
  tools?: { type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }[];
  stream?: boolean;
  think?: unknown;
}

export type FakeReply = { content?: string; thinking?: string; tool_calls?: { function: { name: string; arguments: unknown } }[] } | { error: string; status: number };

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Minimal Ollama-compatible server: /api/chat streams NDJSON replies from a script; /api/show reports a context length. */
export class FakeOllama {
  readonly requests: { path: string; body: OllamaChatBody; auth?: string }[] = [];
  private server: Server | null = null;
  private replies: ((body: OllamaChatBody) => FakeReply)[] = [];
  url = '';

  constructor(private readonly contextLength = 65_536) {}

  script(...replies: (FakeReply | ((body: OllamaChatBody) => FakeReply))[]) {
    this.replies.push(...replies.map((r) => (typeof r === 'function' ? r : () => r)));
  }

  async start(): Promise<this> {
    this.server = createServer(async (req, res) => {
      const body = JSON.parse((await readBody(req)) || '{}') as OllamaChatBody;
      this.requests.push({ path: req.url ?? '', body, auth: req.headers.authorization });
      if (req.url === '/api/show') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ model_info: { 'general.architecture': 'test', 'test.context_length': this.contextLength } }));
        return;
      }
      if (req.url !== '/api/chat') {
        res.statusCode = 404;
        res.end('{"error":"not found"}');
        return;
      }
      const next = this.replies.shift();
      const reply = next ? next(body) : { error: 'no scripted reply', status: 500 };
      if ('error' in reply) {
        res.statusCode = reply.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: reply.error }));
        return;
      }
      res.setHeader('Content-Type', 'application/x-ndjson');
      const base = { model: body.model, created_at: new Date().toISOString() };
      const write = (o: object) => res.write(`${JSON.stringify({ ...base, ...o })}\n`);
      if (reply.thinking) write({ message: { role: 'assistant', content: '', thinking: reply.thinking }, done: false });
      for (const piece of reply.content?.match(/[\s\S]{1,7}/g) ?? []) write({ message: { role: 'assistant', content: piece }, done: false });
      if (reply.tool_calls) write({ message: { role: 'assistant', content: '', tool_calls: reply.tool_calls }, done: false });
      write({ message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 1234, eval_count: 56 });
      res.end();
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
    return this;
  }

  chatRequests() {
    return this.requests.filter((r) => r.path === '/api/chat');
  }

  async stop() {
    await new Promise((r) => this.server?.close(r));
  }
}
