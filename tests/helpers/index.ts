import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Message, ToolCall } from 'ollama';
import type { AgentDeps } from '../../src/agents/types';
import type { AgentName } from '../../src/config';
import type { ChatRequest, ChatResult, LLM, WebClient, WebPage, WebSearchResult } from '../../src/llm/types';
import { SkillLibrary } from '../../src/skills';
import { Store } from '../../src/store';

export const SKILLS_DIR = fileURLToPath(new URL('../../skills', import.meta.url));

export async function tempDir(prefix = 'cvw-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function agentOf(req: ChatRequest): AgentName {
  const system = req.messages[0]?.content ?? '';
  if (system.startsWith('You are the Writer')) return 'writer';
  if (system.startsWith('You are the Critic')) return 'critic';
  return 'coordinator';
}

export type ScriptStep =
  | { content?: string; thinking?: string; tools?: Array<[name: string, args: Record<string, unknown>]> }
  | ((req: ChatRequest) => { content?: string; thinking?: string; tools?: Array<[string, Record<string, unknown>]> });

/**
 * Deterministic LLM for tests. Each agent has its own queue of replies; when a queue is
 * empty the agent answers with a plain "done" message. Every request is recorded.
 */
export class ScriptedLLM implements LLM {
  readonly requests: Array<{ agent: AgentName; request: ChatRequest }> = [];
  private queues: Record<AgentName, ScriptStep[]>;

  constructor(
    script: Partial<Record<AgentName, ScriptStep[]>> = {},
    private window = 100_000,
  ) {
    this.queues = { coordinator: [...(script.coordinator ?? [])], writer: [...(script.writer ?? [])], critic: [...(script.critic ?? [])] };
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    if (req.signal?.aborted) throw new Error('Aborted');
    const agent = agentOf(req);
    this.requests.push({ agent, request: { ...req, messages: structuredClone(req.messages) } });
    const step = this.queues[agent].shift() ?? { content: `${agent} done` };
    const reply = typeof step === 'function' ? step(req) : step;
    if (reply.thinking) req.onDelta?.({ thinking: reply.thinking });
    for (const piece of (reply.content ?? '').match(/.{1,12}/gs) ?? []) req.onDelta?.({ content: piece });
    const message: Message = { role: 'assistant', content: reply.content ?? '' };
    if (reply.thinking) message.thinking = reply.thinking;
    if (reply.tools?.length) {
      message.tool_calls = reply.tools.map(([name, args]): ToolCall => ({ function: { name, arguments: args } }));
    }
    const promptTokens = Math.ceil(JSON.stringify(req.messages).length / 4);
    return { message, promptTokens, outputTokens: Math.ceil((reply.content ?? '').length / 4) + 5 };
  }

  async contextWindow(): Promise<number> {
    return this.window;
  }

  callsFor(agent: AgentName) {
    return this.requests.filter((r) => r.agent === agent);
  }
}

export class FakeWeb implements WebClient {
  searches: string[] = [];
  fetches: string[] = [];
  async search(query: string, maxResults: number): Promise<WebSearchResult[]> {
    this.searches.push(query);
    return Array.from({ length: Math.min(maxResults, 2) }, (_, i) => ({
      title: `Result ${i + 1} for ${query}`,
      url: `https://example.com/${i + 1}`,
      content: `Content about ${query}`,
    }));
  }
  async fetch(url: string): Promise<WebPage> {
    this.fetches.push(url);
    return { title: 'Senior Engineer at Acme', url, content: 'We need Python, AWS and leadership.', links: ['https://acme.test/apply'] };
  }
}

export function makeDeps(root: string, llm: LLM = new ScriptedLLM(), overrides: Partial<AgentDeps> = {}): AgentDeps {
  return {
    store: new Store(root),
    llm,
    web: new FakeWeb(),
    skills: new SkillLibrary(SKILLS_DIR),
    models: { coordinator: 'test-coordinator', writer: 'test-writer', critic: 'test-critic' },
    now: () => new Date('2026-10-21T12:00:00Z'),
    timeZone: 'Europe/London',
    ...overrides,
  };
}

/** Parses a buffered SSE response body into JSON events. */
export function parseSSE(text: string): Array<{ type: string; [k: string]: any }> {
  return text
    .split('\n\n')
    .map((block) => block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).join('\n'))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}
