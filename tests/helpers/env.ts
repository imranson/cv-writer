import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type AgentName, type Config } from '../../src/config.js';
import { createDb, type Db } from '../../src/db/index.js';
import { migrate } from '../../src/db/schema.js';
import { createRepo, type Repo } from '../../src/db/repo.js';
import { SkillLibrary } from '../../src/skills/loader.js';
import { AgentRuntime } from '../../src/agents/runtime.js';
import { ChatService } from '../../src/chat/service.js';
import { createApp } from '../../src/server/app.js';
import type { LlmClient } from '../../src/llm/types.js';
import type { WebClient } from '../../src/lib/web.js';
import type { AgentEvent } from '../../src/agents/events.js';
import type { PageCounter, ToolContext } from '../../src/agents/tool.js';
import { hashPassword } from '../../src/auth/password.js';
import { ScriptedLlm } from './scriptedLlm.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const FIXED_NOW = new Date('2026-11-08T12:00:00Z');

export function fakeWeb(overrides: Partial<WebClient> = {}): WebClient & { searches: string[]; fetches: string[] } {
  const searches: string[] = [];
  const fetches: string[] = [];
  return {
    searches,
    fetches,
    async search(query, max = 5) {
      searches.push(query);
      return [{ title: `Result for ${query}`, url: 'https://example.com/r', content: `snippet (${max})` }].slice(0, max);
    },
    async fetch(url) {
      fetches.push(url);
      return { url, title: 'Example job advert', content: 'We are hiring a Senior Engineer. Requirements: Python, AWS.', source: 'ollama' as const };
    },
    ...overrides,
  };
}

export const fakePages: PageCounter = {
  async countPages(html) {
    return Math.max(1, Math.ceil(html.length / 3000));
  },
};

export interface TestEnv {
  db: Db;
  repo: Repo;
  config: Config;
  skills: SkillLibrary;
  llm: LlmClient;
  web: ReturnType<typeof fakeWeb>;
  runtime: AgentRuntime;
  chat: ChatService;
  app: ReturnType<typeof createApp>;
  close(): Promise<void>;
}

export interface TestEnvOptions {
  llm?: LlmClient;
  env?: Record<string, string>;
  pdf?: { render: (...args: any[]) => Promise<Buffer> };
  pages?: PageCounter | null;
}

export async function createTestEnv(opts: TestEnvOptions = {}): Promise<TestEnv> {
  const db = await createDb({});
  await migrate(db);
  const repo = createRepo(db);
  const config = loadConfig({ DEFAULT_CONTEXT_WINDOW: '32768', OLLAMA_HOST: 'http://ollama.test', ...opts.env }, ROOT);
  const skills = await SkillLibrary.load(config.skillsDir);
  const llm = opts.llm ?? new ScriptedLlm();
  const web = fakeWeb();
  const runtime = new AgentRuntime({
    config,
    repo,
    llm,
    web,
    skills,
    pages: opts.pages === null ? undefined : (opts.pages ?? fakePages),
    now: () => FIXED_NOW,
  });
  const chat = new ChatService(repo, runtime);
  const pdf = opts.pdf ?? { render: async () => Buffer.from('%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n%%EOF') };
  const app = createApp({ config, repo, runtime, chat, skills, pdf });
  return {
    db,
    repo,
    config,
    skills,
    llm,
    web,
    runtime,
    chat,
    app,
    async close() {
      await chat.shutdown();
      await db.close();
    },
  };
}

export async function createUser(repo: Repo, email = 'ann@example.com', name = 'Ann Example') {
  return repo.createUser({ email, name, passwordHash: await hashPassword('password123') });
}

export function toolContext(env: Pick<TestEnv, 'runtime'>, userId: string, agent: AgentName, extra: Partial<ToolContext> = {}) {
  const events: AgentEvent[] = [];
  const ctx: ToolContext = {
    userId,
    agent,
    runId: 'run-test',
    emit: (e) => events.push(e),
    services: env.runtime.services,
    counters: new Map(),
    ...extra,
  };
  return { ctx, events };
}

/** Cookie-jar HTTP client for the Hono app (no network). */
export class TestClient {
  cookie = '';
  constructor(private readonly app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> }) {}

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    const init: RequestInit = { method, headers: { ...(this.cookie ? { cookie: this.cookie } : {}), ...headers } };
    if (body !== undefined) {
      init.body = typeof body === 'string' ? body : JSON.stringify(body);
      (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
    } else if (method !== 'GET') {
      (init.headers as Record<string, string>)['content-type'] ??= 'application/json';
    }
    const res = await this.app.request(`http://localhost${path}`, init);
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(';');
      const [name, value] = pair.split('=');
      if (name === 'cvw_sessions') this.cookie = value && !/Max-Age=0/i.test(c) ? `${name}=${value}` : '';
    }
    return res;
  }

  async json<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await this.req(method, path, body);
    return { status: res.status, body: (await res.json()) as T };
  }

  async register(email = 'ann@example.com', password = 'password123', name = 'Ann') {
    return this.json('POST', '/api/auth/register', { email, password, name });
  }
}

/** Parses an SSE body into JSON events. */
export async function readSse(res: Response): Promise<AgentEvent[]> {
  const text = await res.text();
  return text
    .split(/\n\n/)
    .map((block) =>
      block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join(''),
    )
    .filter(Boolean)
    .map((d) => JSON.parse(d));
}
