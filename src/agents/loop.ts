import type { AgentName, ThinkSetting } from '../config.js';
import { AbortError, type ChatMessage, type LLM } from '../llm/types.js';
import { renderSkills, type Skill } from '../skills/loader.js';
import { executeToolCall, toToolSchema, type Tool } from '../tools/tool.js';
import { ContextMeter, formatSystemInfo } from './context.js';
import type { Emit } from './events.js';

export interface AgentSpec {
  name: AgentName;
  model: string;
  instructions: string;
  tools: Tool[];
  maxSteps: number;
  think?: ThinkSetting;
}

export interface RunOptions {
  llm: LLM;
  emit: Emit;
  depth: number;
  skills: Skill[];
  contextWindow: number;
  signal?: AbortSignal;
  now?: () => Date;
  timeZone?: string;
  /** Called after each message is appended to the history (for persistence). */
  onMessage?: (message: ChatMessage) => Promise<void> | void;
}

export interface AgentResult {
  text: string;
  usedTokens: number;
  contextWindow: number;
  completed: boolean;
}

export function buildSystemPrompt(spec: AgentSpec, skills: Skill[], systemInfo: string): string {
  return [spec.instructions, renderSkills(skills), systemInfo].filter(Boolean).join('\n\n');
}

/**
 * Runs one agent until it answers without tool calls (or hits maxSteps).
 * Appends every message to `history` in place. The system prompt is rebuilt on each
 * step so the agent always sees the current time and context usage.
 */
export async function runAgent(spec: AgentSpec, history: ChatMessage[], opts: RunOptions): Promise<AgentResult> {
  const { llm, emit, depth, signal } = opts;
  const now = opts.now ?? (() => new Date());
  const timeZone = opts.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const meter = new ContextMeter(opts.contextWindow);
  const toolSchemas = spec.tools.map(toToolSchema);
  const base = { agent: spec.name, depth };
  let usedTokens = 0;

  const append = async (message: ChatMessage) => {
    history.push(message);
    await opts.onMessage?.(message);
  };

  for (let step = 0; step < spec.maxSteps; step++) {
    if (signal?.aborted) throw new AbortError();

    // Two passes so the reported usage includes the system prompt itself.
    const draft = buildSystemPrompt(spec, opts.skills, formatSystemInfo({ now: now(), timeZone, usedTokens: 0, contextWindow: meter.window }));
    usedTokens = meter.used(draft, history);
    const system = buildSystemPrompt(spec, opts.skills, formatSystemInfo({ now: now(), timeZone, usedTokens, contextWindow: meter.window }));
    emit({ type: 'context', ...base, usedTokens, contextWindow: meter.window });

    const { message, usage } = await llm.chat(
      {
        agent: spec.name,
        model: spec.model,
        messages: [{ role: 'system', content: system }, ...history],
        tools: toolSchemas,
        think: spec.think,
        signal,
      },
      (delta) => emit({ type: 'delta', ...base, ...delta }),
    );
    await append(message);
    meter.record(usage, history.length);
    usedTokens = meter.used(system, history);
    emit({ type: 'context', ...base, usedTokens, contextWindow: meter.window });

    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      emit({ type: 'message', ...base, content: message.content });
      return { text: message.content, usedTokens, contextWindow: meter.window, completed: true };
    }

    // Sequential on purpose: tools have side effects (writes, delegation) that later calls may depend on.
    for (const [i, call] of calls.entries()) {
      const name = call.function?.name ?? '';
      emit({ type: 'tool_call', ...base, name, args: call.function?.arguments });
      try {
        if (signal?.aborted) throw new AbortError();
        const outcome = await executeToolCall(spec.tools, call, { agent: spec.name, depth, emit, signal });
        emit({ type: 'tool_result', ...base, name: outcome.name, ok: outcome.ok, output: outcome.output });
        await append({ role: 'tool', tool_name: outcome.name, content: outcome.output });
      } catch (err) {
        // Keep the history well-formed (every tool call gets a result) before propagating the stop.
        for (const pending of calls.slice(i)) {
          await append({ role: 'tool', tool_name: pending.function?.name ?? '', content: 'Cancelled: the user stopped the run.' });
        }
        throw err;
      }
    }
  }

  const text = `[${spec.name} stopped after ${spec.maxSteps} steps without a final answer]`;
  return { text, usedTokens, contextWindow: meter.window, completed: false };
}
