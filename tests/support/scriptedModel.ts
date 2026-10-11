import { AbortError, type ChatMessage, type ChatModel, type ChatRequest, type ChatResult, type Usage } from '../../src/llm/types.ts';

export type Step = ChatMessage | ((request: ChatRequest, index: number) => ChatMessage | Promise<ChatMessage>);

export interface ScriptedModelOptions {
  name?: string;
  contextLength?: number;
  /** Token usage to report; defaults to a character-based estimate. */
  usage?: (request: ChatRequest, reply: ChatMessage) => Usage;
  /** Used once the scripted steps run out (otherwise the model throws). */
  fallback?: Step;
}

export const say = (content: string, thinking?: string): ChatMessage => ({ role: 'assistant', content, ...(thinking ? { thinking } : {}) });

export const call = (name: string, args: Record<string, unknown> = {}, content = ''): ChatMessage => ({
  role: 'assistant',
  content,
  toolCalls: [{ name, arguments: args }],
});

export const calls = (...list: [string, Record<string, unknown>][]): ChatMessage => ({
  role: 'assistant',
  content: '',
  toolCalls: list.map(([name, args]) => ({ name, arguments: args })),
});

/** Resolves when the request is aborted — for simulating a slow model. */
export function waitForAbort(request: ChatRequest): Promise<never> {
  return new Promise((_resolve, reject) => {
    if (request.signal?.aborted) reject(new AbortError());
    request.signal?.addEventListener('abort', () => reject(new AbortError()), { once: true });
  });
}

/**
 * Deterministic ChatModel for tests: replays scripted assistant messages in order,
 * streams their content/thinking through onDelta, and records every request.
 */
export class ScriptedModel implements ChatModel {
  readonly name: string;
  readonly requests: ChatRequest[] = [];
  private readonly steps: Step[];
  private calls = 0;

  constructor(
    steps: Step[] = [],
    private readonly opts: ScriptedModelOptions = {},
  ) {
    this.steps = [...steps];
    this.name = opts.name ?? 'scripted';
  }

  get remaining(): number {
    return this.steps.length;
  }

  push(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  /** The last user/tool message content the model was shown in the most recent request. */
  lastInput(): string {
    const last = this.requests.at(-1)?.messages.at(-1);
    return last?.content ?? '';
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push({ ...request, messages: request.messages.map((m) => ({ ...m })) });
    if (request.signal?.aborted) throw new AbortError();
    const step = this.steps.shift() ?? this.opts.fallback;
    if (!step) throw new Error(`ScriptedModel(${this.name}): no scripted response for call #${this.calls + 1}`);
    const index = this.calls++;
    const reply = typeof step === 'function' ? await step(request, index) : step;
    const message: ChatMessage = { ...reply, role: 'assistant' };
    if (message.thinking) request.onDelta?.({ thinking: message.thinking });
    for (const chunk of message.content.match(/[\s\S]{1,12}/g) ?? []) {
      if (request.signal?.aborted) throw new AbortError();
      request.onDelta?.({ content: chunk });
    }
    const usage = this.opts.usage?.(request, message) ?? {
      promptTokens: Math.ceil(request.messages.reduce((n, m) => n + m.content.length, 0) / 4),
      completionTokens: Math.ceil(message.content.length / 4) + 1,
    };
    return { message, usage, doneReason: 'stop' };
  }

  async contextLength(): Promise<number> {
    return this.opts.contextLength ?? 100_000;
  }
}
