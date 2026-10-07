import { z } from 'zod';
import type { ChatMessage, Usage } from '../domain/schemas.js';
import type { ChatDelta, ChatModel, Think, ToolSpec } from '../llm/types.js';
import { estimateTokens, stripNulls, truncate } from '../util/text.js';

export type AgentName = 'coordinator' | 'writer' | 'critic';

export type AgentEvent =
  | { type: 'delta'; agent: AgentName; content?: string; thinking?: string; reset?: boolean }
  | { type: 'tool_start'; agent: AgentName; tool: string; label: string }
  | { type: 'tool_end'; agent: AgentName; tool: string; ok: boolean; label: string }
  /** Text a model wrote alongside tool calls (not its final reply). */
  | { type: 'note'; agent: AgentName; text: string }
  | { type: 'activity'; agent: AgentName; text: string }
  /** A sub-agent is still generating (thinking or writing); characters so far in this call. */
  | { type: 'progress'; agent: AgentName; chars: number }
  /** Stored state changed; the UI refreshes these views. */
  | { type: 'state'; changed: Array<'profile' | 'jobs' | 'cvs' | 'style' | 'session'> };

export type Emit = (event: AgentEvent) => void;

/** A failure the model should see and can recover from (bad id, rule violation, ...). */
export class ToolError extends Error {}

export interface Tool {
  name: string;
  description: string;
  schema: z.ZodType;
  /** State-changing tools are audited on success as well as failure. */
  mutates?: boolean;
  /** Short human-readable description for the activity feed. */
  label?: (args: never) => string;
  run: (args: never) => Promise<unknown>;
}

export function defineTool<S extends z.ZodType>(tool: {
  name: string;
  description: string;
  schema: S;
  mutates?: boolean;
  label?: (args: z.infer<S>) => string;
  run: (args: z.infer<S>) => Promise<unknown>;
}): Tool {
  return tool as unknown as Tool;
}

export function toolSpec(tool: Tool): ToolSpec {
  const { $schema: _ignored, ...parameters } = z.toJSONSchema(tool.schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters } };
}

export interface AuditSink {
  audit(record: { actor: string; action: string; outcome: 'ok' | 'error' | 'refused'; details?: unknown }): Promise<void>;
}

export interface AgentConfig {
  name: AgentName;
  model: string;
  llm: ChatModel;
  /** Rebuilt before every model call so it always reflects the latest stored state. */
  system: () => Promise<string> | string;
  tools: Tool[];
  maxSteps?: number;
  think?: Think;
  /** Stream reply tokens to the UI (true), or just report that the model is still working ('progress'). */
  stream?: boolean | 'progress';
  emit?: Emit;
  audit?: AuditSink;
  /** Context budget in (estimated) tokens for the history sent to the model. */
  contextTokens?: number;
  maxToolResultChars?: number;
  /**
   * Called when the model wants to stop. Returning text sends it back to the model as a reminder
   * and continues the loop (e.g. "you have not had the draft reviewed yet").
   */
  beforeFinish?: (reply: string) => Promise<string | undefined> | string | undefined;
}

export interface AgentResult {
  reply: string;
  /** Messages added during this run (assistant turns, tool results, reminders). */
  messages: ChatMessage[];
  usage: Usage;
  stoppedBy: 'reply' | 'max_steps';
}

const RESULT_OMITTED = '[older tool result removed to save context — the system prompt has the current state]';

/** Shrinks old, bulky messages so a long conversation keeps fitting the model's context. */
export function compactHistory(messages: ChatMessage[], budgetTokens: number, keepRecent = 12): ChatMessage[] {
  const size = (ms: ChatMessage[]) => ms.reduce((n, m) => n + estimateTokens(m.content) + estimateTokens(JSON.stringify(m.tool_calls ?? '')), 0);
  if (size(messages) <= budgetTokens) return messages;
  const out = messages.map((m) => ({ ...m }));
  const cutoff = Math.max(0, out.length - keepRecent);
  for (let i = 0; i < cutoff && size(out) > budgetTokens; i++) {
    const m = out[i]!;
    if (m.role === 'tool' && m.content.length > 300) m.content = RESULT_OMITTED;
    else if (m.content.length > 2000) m.content = truncate(m.content, 2000);
    delete m.thinking;
  }
  // Last resort: drop the oldest messages, never splitting an assistant turn from its tool results.
  while (out.length > keepRecent && size(out) > budgetTokens) {
    out.shift();
    while (out[0]?.role === 'tool') out.shift();
  }
  return out;
}

function parseArgs(raw: Record<string, unknown>): unknown {
  if (typeof raw.__unparseable === 'string') throw new ToolError(`Arguments were not valid JSON: ${truncate(raw.__unparseable, 200)}`);
  return stripNulls(raw);
}

export async function runAgent(config: AgentConfig, history: ChatMessage[]): Promise<AgentResult> {
  const maxSteps = config.maxSteps ?? 16;
  const maxToolResultChars = config.maxToolResultChars ?? 16_000;
  const tools = new Map(config.tools.map((t) => [t.name, t]));
  const specs = config.tools.map(toolSpec);
  const added: ChatMessage[] = [];
  const usage: Usage = { promptTokens: 0, outputTokens: 0, calls: 0 };
  const emit = config.emit ?? (() => undefined);
  let emptyRetries = 0;
  let reminders = 0;

  for (let step = 0; step < maxSteps; step++) {
    const system = await config.system();
    const context = compactHistory([...history, ...added], config.contextTokens ?? 60_000);
    const { message, usage: u } = await config.llm.chat(
      { model: config.model, messages: [{ role: 'system', content: system }, ...context], tools: specs, ...(config.think !== undefined ? { think: config.think } : {}) },
      config.stream === true ? (d) => emit({ type: 'delta', agent: config.name, ...d }) : config.stream === 'progress' ? progressReporter(config.name, emit) : undefined,
    );
    usage.calls += 1;
    usage.promptTokens += u.promptTokens;
    usage.outputTokens += u.outputTokens;

    if (message.tool_calls?.length) {
      added.push(message);
      if (message.content.trim()) emit({ type: 'note', agent: config.name, text: message.content.trim() });
      for (const call of message.tool_calls) {
        const content = await executeTool(config, tools, call.function.name, call.function.arguments, emit);
        added.push({ role: 'tool', tool_name: call.function.name, content: truncate(content, maxToolResultChars) });
      }
      continue;
    }

    let reply = message.content.trim();
    if (!reply) {
      if (emptyRetries++ < 1) {
        added.push({ role: 'user', content: '(Your last reply was empty. Continue: call a tool or reply in text.)' });
        continue;
      }
      reply = 'Sorry, I did not manage to produce a reply. Could you say that again?';
    }
    if (config.beforeFinish && reminders < 2) {
      const reminder = await config.beforeFinish(reply);
      if (reminder) {
        reminders += 1;
        if (reply) added.push(message);
        added.push({ role: 'user', content: reminder });
        emit({ type: 'delta', agent: config.name, reset: true });
        continue;
      }
    }
    added.push({ ...message, content: reply });
    return { reply, messages: added, usage, stoppedBy: 'reply' };
  }
  const reply = 'I ran out of steps before finishing this. Tell me to continue and I will pick up where I left off.';
  added.push({ role: 'assistant', content: reply });
  await config.audit?.audit({ actor: config.name, action: 'max_steps', outcome: 'error', details: { maxSteps } });
  return { reply, messages: added, usage, stoppedBy: 'max_steps' };
}

async function executeTool(
  config: AgentConfig,
  tools: Map<string, Tool>,
  name: string,
  rawArgs: Record<string, unknown>,
  emit: Emit,
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) {
    await config.audit?.audit({ actor: config.name, action: name, outcome: 'refused', details: { reason: 'tool not available to this agent', args: rawArgs } });
    return JSON.stringify({ error: `Tool "${name}" is not available to you. Available tools: ${[...tools.keys()].join(', ')}` });
  }
  let args: unknown;
  try {
    const parsed = tool.schema.safeParse(parseArgs(rawArgs));
    if (!parsed.success) {
      await config.audit?.audit({ actor: config.name, action: name, outcome: 'error', details: { reason: 'invalid arguments', args: rawArgs } });
      return JSON.stringify({ error: `Invalid arguments for ${name}:\n${z.prettifyError(parsed.error)}\nFix them and call ${name} again.` });
    }
    args = parsed.data;
  } catch (err) {
    return JSON.stringify({ error: (err as Error).message });
  }
  const label = tool.label ? safeLabel(() => (tool.label as (a: unknown) => string)(args), name) : name;
  emit({ type: 'tool_start', agent: config.name, tool: name, label });
  try {
    const result = await (tool.run as (a: unknown) => Promise<unknown>)(args);
    if (tool.mutates) await config.audit?.audit({ actor: config.name, action: name, outcome: 'ok', details: { args } });
    emit({ type: 'tool_end', agent: config.name, tool: name, ok: true, label });
    return typeof result === 'string' ? result : JSON.stringify(result ?? { ok: true });
  } catch (err) {
    const message = (err as Error).message || String(err);
    await config.audit?.audit({ actor: config.name, action: name, outcome: 'error', details: { args, error: message } });
    emit({ type: 'tool_end', agent: config.name, tool: name, ok: false, label });
    return JSON.stringify({ error: message });
  }
}

/** Turns a stream of deltas into an occasional "still working" event. */
export function progressReporter(agent: AgentName, emit: Emit, everyMs = 1500, now: () => number = Date.now): (d: ChatDelta) => void {
  let chars = 0;
  let last = 0;
  return (d) => {
    if (d.reset) chars = 0;
    chars += (d.content?.length ?? 0) + (d.thinking?.length ?? 0);
    if (now() - last >= everyMs) {
      last = now();
      emit({ type: 'progress', agent, chars });
    }
  };
}

function safeLabel(fn: () => string, fallback: string): string {
  try {
    return fn() || fallback;
  } catch {
    return fallback;
  }
}
