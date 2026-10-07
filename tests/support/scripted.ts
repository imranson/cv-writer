import type { ChatMessage } from '../../src/domain/schemas.js';
import type { ChatDelta, ChatModel, ChatRequest, ChatResult } from '../../src/llm/types.js';

export interface Reply {
  content?: string;
  thinking?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> }>;
}
export type Step = Reply | ((request: ChatRequest) => Reply);

export const say = (content: string): Reply => ({ content });
export const call = (name: string, args: Record<string, unknown> = {}, content = ''): Reply => ({ content, calls: [{ name, args }] });

/**
 * A stand-in model with one queue of scripted replies per model name, so coordinator, writer and
 * critic can be scripted independently. Every request is recorded for assertions.
 */
export class ScriptedModel implements ChatModel {
  readonly requests: ChatRequest[] = [];
  private queues: Map<string, Step[]>;

  constructor(scripts: Record<string, Step[]>) {
    this.queues = new Map(Object.entries(scripts).map(([k, v]) => [k, [...v]]));
  }

  push(model: string, ...steps: Step[]): void {
    this.queues.set(model, [...(this.queues.get(model) ?? []), ...steps]);
  }

  remaining(model: string): number {
    return this.queues.get(model)?.length ?? 0;
  }

  requestsFor(model: string): ChatRequest[] {
    return this.requests.filter((r) => r.model === model);
  }

  async chat(request: ChatRequest, onDelta?: (d: ChatDelta) => void): Promise<ChatResult> {
    this.requests.push(structuredClone(request));
    const queue = this.queues.get(request.model);
    const step = queue?.shift();
    if (!step) throw new Error(`ScriptedModel: no scripted reply left for ${request.model}`);
    const reply = typeof step === 'function' ? step(request) : step;
    if (onDelta && reply.content) for (const word of reply.content.split(/(?<= )/)) onDelta({ content: word });
    const message: ChatMessage = { role: 'assistant', content: reply.content ?? '' };
    if (reply.thinking) message.thinking = reply.thinking;
    if (reply.calls?.length) message.tool_calls = reply.calls.map((c) => ({ function: { name: c.name, arguments: c.args } }));
    return { message, usage: { promptTokens: 100, outputTokens: 20 } };
  }
}

/** The last tool result the model was shown, parsed. */
export function lastToolResult(request: ChatRequest): Record<string, unknown> {
  const tool = [...request.messages].reverse().find((m) => m.role === 'tool');
  if (!tool) throw new Error('no tool result in request');
  return JSON.parse(tool.content) as Record<string, unknown>;
}
