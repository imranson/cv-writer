import type { Message, Tool } from 'ollama';
import { nanoid } from 'nanoid';
import type { AgentName } from '../config';
import type { ContextUsage } from '../store';
import { truncate } from '../util/text';
import { compactMessages, estimateTokens } from './context';
import { buildSystemPrompt } from './prompts';
import { executeTool, toOllamaTool, toolsFor } from './tools';
import type { AgentDeps, EmitInput, ToolContext } from './types';

export const MAX_STEPS: Record<AgentName, number> = { coordinator: 24, writer: 30, critic: 12 };
/** Fraction of the window history may fill before older content is compacted. */
const COMPACT_AT = 0.8;
/** Tool results larger than this are truncated before going back to the model. */
const MAX_TOOL_RESULT_CHARS = 60_000;
/** Activity log entries keep a shorter copy of each result. */
const MAX_LOGGED_RESULT_CHARS = 20_000;

const toolCache = new Map<AgentName, Tool[]>();
function ollamaToolsFor(agent: AgentName): Tool[] {
  let tools = toolCache.get(agent);
  if (!tools) {
    tools = toolsFor(agent).map(toOllamaTool);
    toolCache.set(agent, tools);
  }
  return tools;
}

export interface RunOptions {
  deps: AgentDeps;
  agent: AgentName;
  userId: string;
  /** Conversation so far (without system prompt). Not mutated. */
  messages: Message[];
  emit: (event: EmitInput) => void;
  signal?: AbortSignal;
  parentRunId?: string;
  task?: string;
  activeJobId?: string;
  /** Usage from a previous run, shown to the model before the first real count arrives. */
  previousUsage?: ContextUsage;
}

export interface RunResult {
  runId: string;
  text: string;
  messages: Message[];
  usage: ContextUsage;
}

export async function runAgent(opts: RunOptions): Promise<RunResult> {
  const { deps, agent, userId, emit, signal } = opts;
  const runId = nanoid(10);
  const model = deps.models[agent];
  const tools = ollamaToolsFor(agent);
  const [contextWindow, skills] = await Promise.all([deps.llm.contextWindow(model), deps.skills.list(agent)]);
  const activeJob = opts.activeJobId ? await deps.store.getJob(userId, opts.activeJobId).catch(() => undefined) : undefined;

  let messages = [...opts.messages];
  let usage: ContextUsage | undefined = opts.previousUsage;
  let finalText = '';

  emit({ type: 'agent_start', runId, agent, parentRunId: opts.parentRunId, task: opts.task });

  const ctx: ToolContext = {
    deps,
    userId,
    agent,
    runId,
    emit,
    signal,
    activeJobId: opts.activeJobId,
    spawn: async (sub, task) => {
      const result = await runAgent({
        deps,
        agent: sub,
        userId,
        messages: [{ role: 'user', content: task }],
        emit,
        signal,
        parentRunId: runId,
        task,
        activeJobId: opts.activeJobId,
      });
      return result.text;
    },
  };

  try {
    for (let step = 0; step < MAX_STEPS[agent]; step++) {
      if (signal?.aborted) throw new Error('Aborted');

      const systemFor = (used: number, estimated: boolean) =>
        buildSystemPrompt(agent, skills, {
          now: deps.now?.() ?? new Date(),
          timeZone: deps.timeZone,
          model,
          usedTokens: used,
          contextWindow,
          estimated,
          activeJob: activeJob && { id: activeJob.id, title: activeJob.title, company: activeJob.company },
        });

      let estimate = estimateTokens(messages, systemFor(0, true), tools);
      if (estimate > contextWindow * COMPACT_AT) {
        const overhead = estimateTokens([], systemFor(0, true), tools);
        messages = compactMessages(messages, Math.floor(contextWindow * COMPACT_AT * 0.75), overhead);
        estimate = estimateTokens(messages, systemFor(0, true), tools);
        usage = undefined;
      }
      // Prefer the model's last real count when it is larger than our character-based estimate.
      const measured = usage && !usage.estimated ? usage.used : 0;
      const system = systemFor(Math.max(estimate, measured), measured < estimate);

      const result = await deps.llm.chat({
        model,
        messages: [{ role: 'system', content: system }, ...messages],
        tools,
        think: deps.think,
        signal,
        onDelta: (d) => emit({ type: 'delta', runId, agent, ...d }),
      });

      const counted = result.promptTokens + result.outputTokens;
      usage = {
        used: counted || estimateTokens([...messages, result.message], system, tools),
        window: contextWindow,
        promptTokens: result.promptTokens,
        outputTokens: result.outputTokens,
        estimated: counted === 0,
        updatedAt: new Date().toISOString(),
      };
      emit({ type: 'usage', runId, agent, usage });

      const assistant: Message = { role: 'assistant', content: result.message.content ?? '' };
      if (result.message.tool_calls?.length) assistant.tool_calls = result.message.tool_calls;
      messages.push(assistant);
      if (assistant.content.trim() || result.message.thinking) {
        emit({ type: 'assistant_message', runId, agent, content: assistant.content, thinking: result.message.thinking });
      }

      const calls = result.message.tool_calls ?? [];
      if (calls.length === 0) {
        finalText = assistant.content;
        break;
      }

      for (const [i, call] of calls.entries()) {
        const callId = `${runId}-${step}-${i}`;
        const name = call.function.name;
        emit({ type: 'tool_call', runId, agent, callId, name, args: call.function.arguments });
        const started = Date.now();
        const outcome = await executeTool(name, call.function.arguments, ctx);
        const content = truncate(outcome.content, MAX_TOOL_RESULT_CHARS);
        emit({
          type: 'tool_result',
          runId,
          agent,
          callId,
          name,
          ok: outcome.ok,
          result: truncate(outcome.content, MAX_LOGGED_RESULT_CHARS),
          durationMs: Date.now() - started,
        });
        messages.push({ role: 'tool', content, tool_name: name });
      }

      if (step === MAX_STEPS[agent] - 1) {
        finalText = `${assistant.content}\n\n[Stopped after ${MAX_STEPS[agent]} steps without a final answer.]`.trim();
      }
    }
  } catch (err: any) {
    emit({ type: 'agent_end', runId, agent, result: finalText, error: err?.message ?? String(err) });
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), { partialMessages: messages });
  }

  emit({ type: 'agent_end', runId, agent, result: finalText });
  return {
    runId,
    text: finalText,
    messages,
    usage: usage ?? {
      used: 0,
      window: contextWindow,
      promptTokens: 0,
      outputTokens: 0,
      estimated: true,
      updatedAt: new Date().toISOString(),
    },
  };
}
