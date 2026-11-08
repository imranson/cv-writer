import { randomUUID } from 'node:crypto';
import type { AgentName } from '../config.js';
import type { ChatMessage, Usage } from '../llm/types.js';
import { clipToolResult, compactMessages, estimateTokens, systemInfoBlock } from './context.js';
import { now, type Emit } from './events.js';
import { formatZodError, toToolSchema, ToolError, type AgentServices, type Tool, type ToolContext } from './tool.js';

export interface AgentSpec {
  agent: AgentName;
  model: string;
  /** Static system prompt (role, rules, skills catalog). System info is appended per call. */
  systemPrompt: string;
  tools: Tool[];
  maxSteps: number;
  contextWindow: number;
}

export interface RunInput {
  spec: AgentSpec;
  /** Conversation so far (no system message). Not mutated. */
  messages: ChatMessage[];
  task: string;
  userId: string;
  services: AgentServices;
  emit: Emit;
  signal?: AbortSignal;
  parentRunId?: string;
  boundJobId?: string;
  timezone?: string;
}

export interface RunResult {
  runId: string;
  ok: boolean;
  aborted: boolean;
  final: string;
  /** Full conversation including this run's assistant and tool messages. */
  messages: ChatMessage[];
  steps: number;
  usage: Usage;
}

const COMPACT_AT = 0.85;
const COMPACT_TO = 0.6;

function serialize(result: unknown): string {
  if (typeof result === 'string') return result;
  if (result === undefined) return 'OK';
  return JSON.stringify(result);
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { spec, services, emit, signal } = input;
  const runId = randomUUID();
  const started = Date.now();
  const tools = new Map(spec.tools.map((t) => [t.name, t]));
  const schemas = spec.tools.map(toToolSchema);
  const usage: Usage = { promptTokens: 0, completionTokens: 0 };
  let messages = [...input.messages];
  /** Last exact token count reported by the model and how many messages it covered. */
  let baseline: { tokens: number; count: number } | null = null;
  let steps = 0;

  emit({ type: 'run_start', runId, parentRunId: input.parentRunId, agent: spec.agent, model: spec.model, task: input.task, at: now() });

  const ctx: ToolContext = {
    userId: input.userId,
    agent: spec.agent,
    runId,
    boundJobId: input.boundJobId,
    timezone: input.timezone,
    emit,
    signal,
    services,
    counters: new Map(),
  };

  const finish = (ok: boolean, final: string, aborted = false): RunResult => {
    emit({ type: 'run_end', runId, agent: spec.agent, ok, result: final, steps, usage, durationMs: Date.now() - started, at: now() });
    return { runId, ok, aborted, final, messages, steps, usage };
  };

  const systemFor = (used: number, estimated: boolean, extra = '') =>
    [
      spec.systemPrompt,
      systemInfoBlock({
        agent: spec.agent,
        now: services.now(),
        timezone: input.timezone,
        usedTokens: used,
        contextWindow: spec.contextWindow,
        estimated,
      }),
      extra,
    ]
      .filter(Boolean)
      .join('\n\n');

  const estimateUsed = () => {
    const fixed = estimateTokens([{ role: 'system', content: systemFor(0, true) }], schemas);
    if (baseline && baseline.count <= messages.length) return baseline.tokens + estimateTokens(messages.slice(baseline.count));
    return fixed + estimateTokens(messages);
  };

  try {
    for (let step = 0; step < spec.maxSteps; step++) {
      if (signal?.aborted) return finish(false, 'Stopped by user.', true);
      steps = step + 1;
      const lastStep = step === spec.maxSteps - 1;

      let used = estimateUsed();
      if (used > spec.contextWindow * COMPACT_AT) {
        const fixed = estimateTokens([{ role: 'system', content: systemFor(0, true) }], schemas);
        const compacted = compactMessages(messages, { targetTokens: spec.contextWindow * COMPACT_TO, fixedTokens: fixed });
        messages = compacted.messages;
        baseline = null;
        used = estimateUsed();
      }
      emit({ type: 'context', runId, agent: spec.agent, usedTokens: used, contextWindow: spec.contextWindow, estimated: true, at: now() });

      const system = systemFor(
        used,
        true,
        lastStep ? 'STEP LIMIT REACHED: tools are disabled for this reply. Give your final answer now, summarising what was done and what remains.' : '',
      );

      emit({ type: 'llm_start', runId, step, at: now() });
      const res = await services.llm.chat(
        {
          model: spec.model,
          messages: [{ role: 'system', content: system }, ...messages],
          tools: lastStep ? undefined : schemas,
          signal,
        },
        {
          onContent: (delta) => emit({ type: 'text_delta', runId, delta }),
          onThinking: (delta) => emit({ type: 'thinking_delta', runId, delta }),
        },
      );

      const assistant: ChatMessage = { role: 'assistant', content: res.message.content ?? '' };
      if (res.message.thinking) assistant.thinking = res.message.thinking;
      const calls = (lastStep ? [] : (res.message.tool_calls ?? [])).map((c, i) => ({
        ...c,
        id: c.id || `${runId.slice(0, 8)}-${step}-${i}`,
      }));
      if (calls.length) assistant.tool_calls = calls;
      messages.push(assistant);

      if (res.usage) {
        usage.promptTokens += res.usage.promptTokens;
        usage.completionTokens += res.usage.completionTokens;
        baseline = { tokens: res.usage.promptTokens + res.usage.completionTokens, count: messages.length };
        emit({
          type: 'context',
          runId,
          agent: spec.agent,
          usedTokens: baseline.tokens,
          contextWindow: spec.contextWindow,
          estimated: false,
          at: now(),
        });
      }
      emit({
        type: 'llm_end',
        runId,
        step,
        content: assistant.content,
        thinking: assistant.thinking,
        toolCalls: calls.map((c) => ({ id: c.id!, name: c.function.name })),
        usage: res.usage,
        durationMs: res.durationMs,
        at: now(),
      });

      if (calls.length === 0) {
        const final = assistant.content.trim() || '(The agent finished without a written reply.)';
        return finish(true, final);
      }

      for (const call of calls) {
        if (signal?.aborted) return finish(false, 'Stopped by user.', true);
        const name = call.function.name;
        const args = call.function.arguments ?? {};
        const callStarted = Date.now();
        emit({ type: 'tool_start', runId, callId: call.id!, name, args, at: now() });
        let ok = true;
        let result: string;
        const tool = tools.get(name);
        if (!tool) {
          ok = false;
          result = `Error: unknown tool "${name}". Available tools: ${[...tools.keys()].join(', ')}`;
        } else {
          const parsed = tool.schema.safeParse(args);
          if (!parsed.success) {
            ok = false;
            result = `Error: invalid arguments for ${name}: ${formatZodError(parsed.error)}`;
          } else {
            try {
              result = serialize(await tool.run(parsed.data, ctx));
            } catch (err) {
              if (signal?.aborted) throw err;
              ok = false;
              const message = err instanceof Error ? err.message : String(err);
              result = `Error: ${err instanceof ToolError ? message : `${name} failed: ${message}`}`;
            }
          }
        }
        result = clipToolResult(result);
        messages.push({ role: 'tool', content: result, tool_name: name, tool_call_id: call.id });
        emit({ type: 'tool_end', runId, callId: call.id!, name, ok, result, durationMs: Date.now() - callStarted, at: now() });
      }
    }
    return finish(false, `Stopped after ${spec.maxSteps} steps without a final answer.`);
  } catch (err) {
    if (signal?.aborted) return finish(false, 'Stopped by user.', true);
    const message = err instanceof Error ? err.message : String(err);
    emit({ type: 'error', runId, message, at: now() });
    return finish(false, `The ${spec.agent} failed: ${message}`);
  }
}
