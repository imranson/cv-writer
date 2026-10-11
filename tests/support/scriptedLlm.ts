import type { AgentName } from '../../src/config.js';
import type { ChatMessage, ChatRequest, ChatResult, Delta, LLM } from '../../src/llm/types.js';
import { AbortError } from '../../src/llm/types.js';

/** Decides the next assistant message for an agent given the request it received. */
export type Script = (req: ChatRequest) => ChatMessage | Promise<ChatMessage>;

export const say = (content: string): ChatMessage => ({ role: 'assistant', content });

export const call = (name: string, args: Record<string, unknown> | string, content = ''): ChatMessage => ({
  role: 'assistant',
  content,
  tool_calls: [{ function: { name, arguments: args } }],
});

export const calls = (...list: [string, Record<string, unknown>][]): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: list.map(([name, args]) => ({ function: { name, arguments: args } })),
});

/** Number of assistant turns since the latest user message (0 = first step of this run/turn). */
export function step(req: ChatRequest): number {
  const lastUser = req.messages.map((m) => m.role).lastIndexOf('user');
  return req.messages.slice(lastUser + 1).filter((m) => m.role === 'assistant').length;
}

export function lastToolResult<T = Record<string, unknown>>(req: ChatRequest, name?: string): T {
  const tools = req.messages.filter((m) => m.role === 'tool' && (!name || m.tool_name === name));
  const last = tools.at(-1);
  if (!last) throw new Error(`No tool result${name ? ` for ${name}` : ''} in request`);
  return JSON.parse(last.content) as T;
}

export function userText(req: ChatRequest): string {
  return req.messages.filter((m) => m.role === 'user').at(-1)?.content ?? '';
}

/** Deterministic LLM double: per-agent scripts, streamed in small chunks, with fake usage numbers. */
export class ScriptedLLM implements LLM {
  readonly requests: ChatRequest[] = [];
  delayMs = 0;

  constructor(
    private readonly scripts: Partial<Record<AgentName, Script>>,
    /** null = backend cannot tell its context window. */
    private readonly window: number | null = 8192,
  ) {}

  async chat(request: ChatRequest, onDelta?: (delta: Delta) => void): Promise<ChatResult> {
    this.requests.push({ ...request, messages: structuredClone(request.messages), signal: undefined });
    const script = this.scripts[request.agent];
    if (!script) throw new Error(`No script for agent ${request.agent}`);
    if (this.delayMs) await sleep(this.delayMs, request.signal);
    const message = await script(request);
    for (const chunk of message.content.match(/[\s\S]{1,12}/g) ?? []) {
      if (request.signal?.aborted) throw new AbortError();
      onDelta?.({ content: chunk });
    }
    const promptTokens = Math.ceil(JSON.stringify(request.messages).length / 4);
    return { message: { ...message, role: 'assistant' }, usage: { promptTokens, completionTokens: Math.ceil(message.content.length / 4) + 5 } };
  }

  async contextWindow(): Promise<number | undefined> {
    return this.window ?? undefined;
  }

  requestsFor(agent: AgentName): ChatRequest[] {
    return this.requests.filter((r) => r.agent === agent);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new AbortError());
      },
      { once: true },
    );
  });
}
