import { randomUUID } from 'node:crypto';
import { AbortError, type ChatMessage, type ChatModel, type Usage } from '../llm/types.ts';
import { noopEmit, type AgentName, type Emit } from './events.ts';
import { formatZodError, toToolSchema, ToolError, type AgentTool } from './tool.ts';

export interface RunAgentOptions {
  agent: AgentName;
  model: ChatModel;
  system: string;
  /** Prior conversation (excluding the system prompt). */
  history: ChatMessage[];
  tools: AgentTool[];
  maxSteps?: number;
  signal?: AbortSignal;
  emit?: Emit;
  /** Called for every message produced during the run, in order (for incremental persistence). */
  onMessage?: (message: ChatMessage) => void | Promise<void>;
}

export interface RunAgentResult {
  messages: ChatMessage[];
  finalText: string;
  /** Usage reported by the last model call: promptTokens + completionTokens ≈ current context size. */
  lastUsage: Usage;
  totalUsage: Usage;
  steps: number;
  stoppedBy: 'final' | 'terminal_tool' | 'max_steps';
  /** Output of the terminal tool, when the run ended through one. */
  terminalOutput?: string;
}

const PREVIEW_CHARS = 400;

export function preview(text: string, max = PREVIEW_CHARS): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Reasoning from earlier turns is not needed again and only costs context. */
function stripThinking(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (m.thinking ? { ...m, thinking: undefined } : m));
}

export async function executeToolCall(
  tools: AgentTool[],
  name: string,
  args: Record<string, unknown>,
  ctx: { signal?: AbortSignal; emit: Emit },
): Promise<{ ok: boolean; output: string; tool?: AgentTool }> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    return { ok: false, output: `Error: unknown tool "${name}". Available tools: ${tools.map((t) => t.name).join(', ')}` };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, output: `Error: invalid arguments for ${name}: ${formatZodError(parsed.error)}`, tool };
  }
  try {
    const output = await tool.run(parsed.data, ctx);
    return { ok: true, output, tool };
  } catch (err) {
    if (ctx.signal?.aborted) throw new AbortError();
    const message = err instanceof ToolError || err instanceof Error ? err.message : String(err);
    return { ok: false, output: `Error: ${message}`, tool };
  }
}

/**
 * Generic tool-calling loop: call the model, execute requested tools, feed results back,
 * until the model answers without tool calls (or a terminal tool succeeds).
 */
export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const { agent, model, tools, signal } = opts;
  const emit = opts.emit ?? noopEmit;
  const maxSteps = opts.maxSteps ?? 12;
  const toolSchemas = tools.map(toToolSchema);
  const history = stripThinking(opts.history);
  const produced: ChatMessage[] = [];
  const totalUsage: Usage = { promptTokens: 0, completionTokens: 0 };
  let lastUsage: Usage = { promptTokens: 0, completionTokens: 0 };

  const record = async (message: ChatMessage) => {
    produced.push(message);
    await opts.onMessage?.(message);
  };

  const callModel = async (withTools: boolean) => {
    if (signal?.aborted) throw new AbortError();
    const result = await model.chat({
      messages: [{ role: 'system', content: opts.system }, ...history, ...produced],
      tools: withTools ? toolSchemas : undefined,
      signal,
      onDelta: (d) => {
        if (d.thinking) emit({ type: 'thinking', agent, delta: d.thinking });
        if (d.content) emit({ type: 'text', agent, delta: d.content });
      },
    });
    lastUsage = result.usage;
    totalUsage.promptTokens += result.usage.promptTokens;
    totalUsage.completionTokens += result.usage.completionTokens;
    emit({ type: 'usage', agent, ...result.usage });
    return result;
  };

  for (let step = 1; step <= maxSteps; step++) {
    let result = await callModel(tools.length > 0);
    // A reply with neither text nor tool calls is useless; give the model one more chance.
    if (!result.message.content.trim() && !result.message.toolCalls?.length) {
      result = await callModel(tools.length > 0);
    }
    const message = result.message;
    await record(message);

    if (!message.toolCalls?.length) {
      return { messages: produced, finalText: message.content, lastUsage, totalUsage, steps: step, stoppedBy: 'final' };
    }

    for (const call of message.toolCalls) {
      const callId = randomUUID();
      emit({ type: 'tool_start', agent, callId, name: call.name, args: call.arguments });
      const { ok, output, tool } = await executeToolCall(tools, call.name, call.arguments, { signal, emit });
      emit({ type: 'tool_end', agent, callId, name: call.name, ok, preview: preview(output) });
      await record({ role: 'tool', toolName: call.name, content: output });
      if (ok && tool?.terminal) {
        return {
          messages: produced,
          finalText: message.content,
          lastUsage,
          totalUsage,
          steps: step,
          stoppedBy: 'terminal_tool',
          terminalOutput: output,
        };
      }
    }
  }

  // Out of steps: ask for a final answer without tools so the turn still ends with a reply.
  const final = await callModel(false);
  await record(final.message);
  return { messages: produced, finalText: final.message.content, lastUsage, totalUsage, steps: maxSteps + 1, stoppedBy: 'max_steps' };
}
