import type { ChatRequest, ChatResult, LlmClient, StreamHandlers, Usage } from '../../src/llm/types.js';

export interface ScriptedReply {
  content?: string;
  thinking?: string;
  toolCalls?: { name: string; args: Record<string, unknown>; id?: string }[];
  usage?: Usage | null;
}

export type ScriptStep = ScriptedReply | Error | ((req: ChatRequest) => ScriptedReply | Error);

export interface RecordedRequest {
  agent: string;
  system: string;
  req: ChatRequest;
}

/** Identifies the calling agent from the <system_info> block in the system prompt. */
export function agentOf(req: ChatRequest): string {
  const system = req.messages.find((m) => m.role === 'system')?.content ?? '';
  return /\bagent: (\w+)/.exec(system)?.[1] ?? 'unknown';
}

/**
 * Deterministic LlmClient for tests: replies are consumed per agent in order,
 * streamed in small chunks through the handlers, like the real Ollama client.
 */
export class ScriptedLlm implements LlmClient {
  readonly requests: RecordedRequest[] = [];

  constructor(
    private readonly scripts: Record<string, ScriptStep[]> = {},
    private readonly opts: { contextWindow?: number; chunkSize?: number; delayMs?: number } = {},
  ) {}

  push(agent: string, ...steps: ScriptStep[]) {
    (this.scripts[agent] ??= []).push(...steps);
  }

  remaining(agent: string): number {
    return this.scripts[agent]?.length ?? 0;
  }

  async chat(req: ChatRequest, handlers: StreamHandlers = {}): Promise<ChatResult> {
    const agent = agentOf(req);
    this.requests.push({ agent, system: req.messages[0]?.content ?? '', req: { ...req, messages: req.messages.map((m) => ({ ...m })) } });
    if (req.signal?.aborted) throw req.signal.reason ?? new Error('aborted');
    if (this.opts.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.opts.delayMs);
        req.signal?.addEventListener('abort', () => (clearTimeout(t), reject(req.signal!.reason ?? new Error('aborted'))), { once: true });
      });
    }
    const queue = this.scripts[agent];
    if (!queue?.length) throw new Error(`ScriptedLlm: no reply left for agent "${agent}"`);
    let step = queue.shift()!;
    if (typeof step === 'function') step = step(req);
    if (step instanceof Error) throw step;

    const size = this.opts.chunkSize ?? 7;
    const content = step.content ?? '';
    for (let i = 0; i < step.thinking?.length!; i += size) handlers.onThinking?.(step.thinking!.slice(i, i + size));
    for (let i = 0; i < content.length; i += size) handlers.onContent?.(content.slice(i, i + size));

    const promptChars = JSON.stringify(req.messages).length + JSON.stringify(req.tools ?? []).length;
    return {
      message: {
        role: 'assistant',
        content,
        ...(step.thinking ? { thinking: step.thinking } : {}),
        ...(step.toolCalls?.length
          ? { tool_calls: step.toolCalls.map((c, i) => ({ id: c.id ?? `call_${this.requests.length}_${i}`, function: { name: c.name, arguments: c.args } })) }
          : {}),
      },
      usage: step.usage === null ? undefined : (step.usage ?? { promptTokens: Math.ceil(promptChars / 4), completionTokens: Math.ceil(content.length / 4) + 5 }),
      durationMs: 3,
    };
  }

  async contextWindow(): Promise<number | undefined> {
    return this.opts.contextWindow;
  }
}

export const reply = (content: string): ScriptedReply => ({ content });
export const call = (name: string, args: Record<string, unknown> = {}, content = ''): ScriptedReply => ({ content, toolCalls: [{ name, args }] });
