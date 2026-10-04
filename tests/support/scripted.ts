import type { ChatIO } from '../../src/app/session.js';
import type { CvVersion } from '../../src/domain/schemas.js';
import type { ChatClient, ChatMessage, ChatRequest, ChatResult } from '../../src/llm/types.js';

export type Reply = Partial<ChatMessage>;
export type Step = Reply | ((request: ChatRequest) => Reply | Promise<Reply>);

let callSeq = 0;

/** An assistant message that answers in plain text. */
export const say = (content: string): Reply => ({ content });

/** An assistant message that calls one tool (optionally with some text alongside). */
export const call = (name: string, args: Record<string, unknown> = {}, content = ''): Reply => ({
  content,
  tool_calls: [{ id: `call_${++callSeq}`, function: { name, arguments: args } }],
});

/** An assistant message that calls several tools at once. */
export const calls = (...list: Array<[string, Record<string, unknown>?]>): Reply => ({
  content: '',
  tool_calls: list.map(([name, args = {}]) => ({ id: `call_${++callSeq}`, function: { name, arguments: args } })),
});

/** A stand-in model that answers each request with the next scripted step. */
export class ScriptedModel implements ChatClient {
  readonly requests: ChatRequest[] = [];

  constructor(private readonly steps: Step[] = []) {}

  get remaining(): number {
    return this.steps.length;
  }

  push(...steps: Step[]): void {
    this.steps.push(...steps);
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    this.requests.push(structuredClone(request));
    const step = this.steps.shift();
    if (!step) throw new Error(`Scripted model "${request.model}" has no response left`);
    const reply = typeof step === 'function' ? await step(request) : step;
    return { message: { role: 'assistant', content: '', ...reply }, promptTokens: 100, outputTokens: 20 };
  }
}

/** One client serving several models, as a single Ollama server does. */
export function byModel(models: Record<string, ChatClient>): ChatClient {
  return {
    chat(request) {
      const model = models[request.model];
      if (!model) throw new Error(`No scripted model "${request.model}"`);
      return model.chat(request);
    },
  };
}

/** The most recent tool result the model has been sent. */
export function lastToolResult(request: ChatRequest): { name?: string; content: string; json<T = any>(): T } {
  const message = request.messages.findLast((m) => m.role === 'tool');
  if (!message) throw new Error('No tool result in request');
  return { ...(message.tool_name ? { name: message.tool_name } : {}), content: message.content, json: () => JSON.parse(message.content) };
}

/** A user who replies from a script (null = leaves) and records everything shown to them. */
export class ScriptedIO implements ChatIO {
  readonly said: string[] = [];
  readonly statuses: string[] = [];
  readonly shown: CvVersion[] = [];
  reads = 0;

  constructor(private readonly replies: Array<string | null | (() => string | null | Promise<string | null>)> = []) {}

  async readUserInput(): Promise<string | null> {
    this.reads += 1;
    const next = this.replies.shift();
    if (next === undefined) return null;
    return typeof next === 'function' ? next() : next;
  }

  say(text: string): void {
    this.said.push(text);
  }

  status(text: string): void {
    this.statuses.push(text);
  }

  showCv(cv: CvVersion): void {
    this.shown.push(cv);
  }
}
