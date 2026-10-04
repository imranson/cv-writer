import { z } from 'zod';
import type { AuditEvent } from '../domain/schemas.js';
import { emptyUsage, type ChatClient, type ChatMessage, type Think, type ToolCall, type ToolSpec, type Usage } from '../llm/types.js';

export interface AgentTool<Args = any> {
  name: string;
  description: string;
  /** Validates the model's arguments before run() sees them. */
  parameters: z.ZodType;
  /** Read-only tools are not written to the audit log (failures always are). */
  readOnly?: boolean;
  run(args: Args): Promise<unknown>;
}

export function defineTool<S extends z.ZodObject>(tool: {
  name: string;
  description: string;
  parameters: S;
  readOnly?: boolean;
  run(args: z.output<S>): Promise<unknown>;
}): AgentTool<z.output<S>> {
  return tool;
}

/** The JSON-schema function definition the model sees. */
export function toolSpec(tool: AgentTool): ToolSpec {
  const { $schema: _, ...parameters } = z.toJSONSchema(tool.parameters, { io: 'input', unrepresentable: 'any' });
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

/** Open models often send null for "not given"; treat it as absent so optional fields validate. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((v) => v !== null).map(dropNulls);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

export const STALE_TOOL_OUTPUT = '[Older tool output removed to keep the conversation within the context window. Call the tool again if you need it.]';

/**
 * Keeps a long conversation within budget by blanking out the oldest bulky tool
 * outputs (the model can always call the tool again). The stored history is untouched.
 */
export function compactHistory(messages: ChatMessage[], maxChars: number, keepRecent = 8): ChatMessage[] {
  const size = (m: ChatMessage) => m.content.length + JSON.stringify(m.tool_calls ?? []).length;
  let total = messages.reduce((n, m) => n + size(m), 0);
  if (total <= maxChars) return messages;
  const out = [...messages];
  for (let i = 0; i < out.length - keepRecent && total > maxChars; i++) {
    const m = out[i]!;
    if (m.role === 'tool' && m.content.length > STALE_TOOL_OUTPUT.length) {
      total -= m.content.length - STALE_TOOL_OUTPUT.length;
      out[i] = { ...m, content: STALE_TOOL_OUTPUT };
    }
  }
  return out;
}

export type AgentEvent =
  | { type: 'text'; agent: string; text: string }
  | { type: 'tool-call'; agent: string; name: string; args: Record<string, unknown> }
  | { type: 'tool-result'; agent: string; name: string; ok: boolean; output: string };

export interface AgentOptions {
  /** Also the actor recorded in the audit log. */
  name: string;
  model: string;
  client: ChatClient;
  systemPrompt: string;
  tools: AgentTool[];
  think?: Think;
  /** Model calls allowed per run(). */
  maxSteps?: number;
  /** Earlier conversation (without the system prompt), e.g. when resuming. */
  history?: ChatMessage[];
  /** Rough context budget in characters; older tool outputs are dropped beyond it. */
  maxContextChars?: number;
  audit?: (event: Omit<AuditEvent, 'at'>) => Promise<void>;
  onEvent?: (event: AgentEvent) => void;
  /** Shared token meter; defaults to one owned by this agent. */
  usage?: Usage;
}

export interface AgentRunResult {
  /** The model's final text for this run ('' if it never produced one). */
  reply: string;
  steps: number;
  stoppedBy: 'reply' | 'max-steps';
}

/**
 * A tool-calling loop over an Ollama chat model: send the conversation, run any
 * tools the model asks for, feed the results back, until it answers in plain text.
 * The tool list is the agent's whole capability set; anything else is refused.
 */
export class Agent {
  readonly name: string;
  readonly model: string;
  readonly messages: ChatMessage[];
  readonly usage: Usage;
  private readonly tools: Map<string, AgentTool>;
  private readonly specs: ToolSpec[];

  constructor(private readonly options: AgentOptions) {
    this.name = options.name;
    this.model = options.model;
    this.messages = [...(options.history ?? [])];
    this.usage = options.usage ?? emptyUsage();
    this.tools = new Map(options.tools.map((t) => [t.name, t]));
    this.specs = options.tools.map(toolSpec);
  }

  get systemPrompt(): string {
    return this.options.systemPrompt;
  }

  async run(input: string): Promise<AgentRunResult> {
    const { client, model, think, maxSteps = 12, maxContextChars = 400_000 } = this.options;
    this.messages.push({ role: 'user', content: input });
    let emptyRetries = 0;

    for (let steps = 1; steps <= maxSteps; steps++) {
      const result = await client.chat({
        model,
        messages: [{ role: 'system', content: this.options.systemPrompt }, ...compactHistory(this.messages, maxContextChars)],
        ...(this.specs.length ? { tools: this.specs } : {}),
        ...(think !== undefined ? { think } : {}),
      });
      this.usage.requests += 1;
      this.usage.promptTokens += result.promptTokens;
      this.usage.outputTokens += result.outputTokens;

      const { content, thinking, tool_calls: calls = [] } = result.message;
      const text = content.trim();
      // Thinking models occasionally stop after reasoning with nothing to show; ask again once.
      if (!text && calls.length === 0 && steps < maxSteps && emptyRetries++ < 1) continue;

      this.messages.push({
        role: 'assistant',
        content,
        ...(thinking ? { thinking } : {}),
        ...(calls.length ? { tool_calls: calls } : {}),
      });
      if (text) this.emit({ type: 'text', agent: this.name, text });
      if (calls.length === 0) return { reply: text, steps, stoppedBy: 'reply' };

      for (const call of calls) {
        const output = await this.execute(call);
        this.messages.push({
          role: 'tool',
          content: output,
          tool_name: call.function.name,
          ...(call.id ? { tool_call_id: call.id } : {}),
        });
      }
    }
    return { reply: '', steps: maxSteps, stoppedBy: 'max-steps' };
  }

  private async execute(call: ToolCall): Promise<string> {
    const { name } = call.function;
    const args = dropNulls(call.function.arguments) as Record<string, unknown>;
    this.emit({ type: 'tool-call', agent: this.name, name, args });

    const finish = async (ok: boolean, output: string, detail: Record<string, unknown>, audit: boolean) => {
      if (audit) await this.options.audit?.({ actor: this.name, action: name, ok, detail: { input: args, ...detail } });
      this.emit({ type: 'tool-result', agent: this.name, name, ok, output });
      return output;
    };

    const tool = this.tools.get(name);
    if (!tool) {
      const available = [...this.tools.keys()].join(', ') || 'none';
      const reason = `There is no tool "${name}" available to the ${this.name}. Available tools: ${available}.`;
      return finish(false, `Error: ${reason}`, { denied: reason }, true);
    }

    const parsed = tool.parameters.safeParse(args);
    if (!parsed.success) {
      const error = z.prettifyError(parsed.error);
      return finish(false, `Error: invalid arguments for ${name}. Fix them and call it again.\n${error}`, { error }, true);
    }

    try {
      const value = await tool.run(parsed.data);
      const output = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      return finish(true, output, {}, !tool.readOnly);
    } catch (err) {
      const error = err instanceof z.ZodError ? z.prettifyError(err) : (err as Error).message;
      return finish(false, `Error: ${name} failed: ${error}`, { error }, true);
    }
  }

  private emit(event: AgentEvent): void {
    this.options.onEvent?.(event);
  }
}
