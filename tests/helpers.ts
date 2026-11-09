import path from 'node:path';
import { createPgliteDb, type Db } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';
import { Repo } from '../src/db/repo.js';
import { SkillRegistry } from '../src/agents/skills.js';
import type { AgentDeps } from '../src/agents/runner.js';
import type { ChatRequest, ChatResponse, LlmClient, ToolCall } from '../src/llm/types.js';
import type { AgentEvent, AgentType } from '../src/shared/events.js';
import { createApp } from '../src/server/app.js';
import { ChatService } from '../src/server/chat-service.js';

export const SKILLS_DIR = path.resolve('skills');

export async function createTestDb(): Promise<{ db: Db; repo: Repo }> {
  const db = await createPgliteDb(':memory:');
  await migrate(db);
  return { db, repo: new Repo(db) };
}

// ------------------------------------------------------------------ scripted LLM

export type Scripted = Partial<ChatResponse> | ((req: ChatRequest) => Partial<ChatResponse> | Promise<Partial<ChatResponse>>);

export function agentOf(req: ChatRequest): AgentType {
  const sys = req.messages[0]?.content ?? '';
  if (sys.startsWith('You are the Coordinator')) return 'coordinator';
  if (sys.startsWith('You are the Writer')) return 'writer';
  if (sys.startsWith('You are the Critic')) return 'critic';
  throw new Error('Unknown agent prompt');
}

export const say = (content: string, thinking = ''): Partial<ChatResponse> => ({ content, thinking });
export const call = (name: string, args: Record<string, unknown> = {}, id?: string): Partial<ChatResponse> => ({
  toolCalls: [{ id, function: { name, arguments: args } }],
});
export const calls = (...list: [string, Record<string, unknown>][]): Partial<ChatResponse> => ({
  toolCalls: list.map(([name, args]) => ({ function: { name, arguments: args } }) as ToolCall),
});

/**
 * Fake LLM: per-agent queues of scripted responses consumed in order. Streams thinking/text
 * through the callbacks like the real client and records every request for assertions.
 */
export class ScriptedLlm implements LlmClient {
  readonly requests: { agent: AgentType; req: ChatRequest }[] = [];
  private queues: Record<AgentType, Scripted[]>;

  constructor(
    script: Partial<Record<AgentType, Scripted[]>> = {},
    private readonly window = 32_000,
  ) {
    this.queues = { coordinator: [...(script.coordinator ?? [])], writer: [...(script.writer ?? [])], critic: [...(script.critic ?? [])] };
  }

  push(agent: AgentType, ...items: Scripted[]) {
    this.queues[agent].push(...items);
  }

  remaining(agent: AgentType) {
    return this.queues[agent].length;
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const agent = agentOf(req);
    this.requests.push({ agent, req: { ...req, messages: structuredClone(req.messages) } });
    const next = this.queues[agent].shift();
    if (!next) throw new Error(`ScriptedLlm: no scripted response left for ${agent}`);
    const partial = typeof next === 'function' ? await next(req) : next;
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
    const res: ChatResponse = {
      content: partial.content ?? '',
      thinking: partial.thinking ?? '',
      toolCalls: partial.toolCalls ?? [],
      usage: partial.usage ?? { promptTokens: 100, evalTokens: 20, durationMs: 5 },
    };
    // Stream in two chunks to exercise delta handling.
    for (const [text, cb] of [[res.thinking, req.onThinking], [res.content, req.onText]] as const) {
      if (!text) continue;
      const mid = Math.ceil(text.length / 2);
      cb?.(text.slice(0, mid));
      if (text.slice(mid)) cb?.(text.slice(mid));
    }
    return res;
  }

  async contextWindow(): Promise<number> {
    return this.window;
  }
}

// ------------------------------------------------------------------ app harness

export class FakePdf {
  renders: { html: string; css: string; pageSize?: string }[] = [];
  async render(html: string, css: string, opts: { pageSize?: string } = {}) {
    this.renders.push({ html, css, pageSize: opts.pageSize });
    return { pdf: Buffer.from('%PDF-1.4 fake'), pages: 1 };
  }
}

export async function createTestApp(opts: { llm?: LlmClient; pdf?: any; deps?: Partial<AgentDeps> } = {}) {
  const { db, repo } = await createTestDb();
  const llm = opts.llm ?? new ScriptedLlm();
  const skills = new SkillRegistry(SKILLS_DIR);
  const deps: AgentDeps = {
    llm,
    repo,
    skills,
    config: { models: { coordinator: 'test-coord', writer: 'test-writer', critic: 'test-critic' }, maxSteps: { coordinator: 8, writer: 8, critic: 4 } },
    web: {},
    ...opts.deps,
  };
  const chat = new ChatService(repo, deps);
  const pdf = opts.pdf ?? new FakePdf();
  const app = createApp({
    config: { models: deps.config.models, cookieSecure: false, publicDir: path.resolve('dist/public'), ollamaHost: 'http://ollama.test' },
    repo,
    skills,
    llm,
    chat,
    pdf,
    dbKind: db.kind,
  });
  return { app, db, repo, llm, chat, pdf, deps };
}

/** Minimal cookie-jar HTTP client over Hono's app.request(). */
export class TestClient {
  cookies = new Map<string, string>();
  constructor(private readonly app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {}

  async request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const h: Record<string, string> = { 'x-cvw': '1', ...headers };
    if (body !== undefined) h['content-type'] = 'application/json';
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await this.app.request(url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const sc of res.headers.getSetCookie()) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  async json<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; body: T }> {
    const res = await this.request(method, url, body, headers);
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  }
}

export async function register(client: TestClient, email: string, name = email.split('@')[0], password = 'password123') {
  const res = await client.json('POST', '/api/auth/register', { email, name, password });
  if (res.status !== 200) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  return res.body.user as { id: string; email: string; name: string };
}

/** Parses an SSE body into agent events. */
export function parseSse(text: string): AgentEvent[] {
  return text
    .split(/\n\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n'),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}

export function collector() {
  const events: AgentEvent[] = [];
  return { events, emit: (e: AgentEvent) => void events.push(e) };
}
