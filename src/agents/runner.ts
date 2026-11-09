import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { WebOptions } from '../lib/web.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import type { AgentType, EmitFn } from '../shared/events.js';
import { compactMessages, contextInfo, estimateTokens, systemInfoBlock } from './context.js';
import { buildSystemPrompt, toolsFor } from './definitions.js';
import type { SkillRegistry } from './skills.js';
import { executeTool, serializeResult, toToolSpec, ToolError, type ToolContext } from './tools/types.js';

export interface AgentDeps {
  llm: LlmClient;
  repo: Repo;
  skills: SkillRegistry;
  config: Pick<Config, 'models' | 'maxSteps'>;
  web: WebOptions;
  /** Clock (injectable for tests). */
  now?: () => Date;
  /** Rendered PDF page count for a user's job CV (optional). */
  pageCount?: (userId: string, jobId: string) => Promise<number | null>;
}

export interface RunOptions {
  agent: AgentType;
  userId: string;
  /** New user message (coordinator) or task description (subagents). */
  input: string;
  /** Prior transcript (coordinator only; subagents always start fresh). */
  history?: ChatMessage[];
  emit: EmitFn;
  signal: AbortSignal;
  focusJobId?: string | null;
  parentRunId?: string;
  parentCallId?: string;
  depth?: number;
  timeZone?: string;
  /** Extra lines for the system information block. */
  extraInfo?: () => Promise<string[]> | string[];
}

export interface RunResult {
  runId: string;
  output: string;
  /** Transcript after this run (without the system prompt). */
  messages: ChatMessage[];
}

export class AbortError extends Error {
  constructor() {
    super('Stopped by user');
    this.name = 'AbortError';
  }
}

const MAX_DEPTH = 3;

export async function runAgent(deps: AgentDeps, opts: RunOptions): Promise<RunResult> {
  const runId = randomUUID();
  const now = deps.now ?? (() => new Date());
  const depth = opts.depth ?? 0;
  const model = deps.config.models[opts.agent];
  const tools = toolsFor(opts.agent);
  const specs = tools.map(toToolSpec);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const skills = await deps.skills.list(opts.agent);
  const basePrompt = buildSystemPrompt(opts.agent, skills);
  const window = await deps.llm.contextWindow(model);
  let messages: ChatMessage[] = [...(opts.history ?? []), { role: 'user', content: opts.input }];
  let lastPromptTokens: number | undefined;

  opts.emit({
    type: 'agent_start',
    runId,
    agent: opts.agent,
    model,
    parentRunId: opts.parentRunId,
    parentCallId: opts.parentCallId,
    depth,
    task: opts.input,
    systemPrompt: basePrompt,
    tools: specs.map((s) => s.function.name),
    at: now().toISOString(),
  });

  const callAgent: ToolContext['callAgent'] = async (agent, task, { jobId, callId }) => {
    if (depth + 1 > MAX_DEPTH) throw new ToolError('Maximum agent nesting depth reached');
    try {
      const res = await runAgent(deps, {
        agent,
        userId: opts.userId,
        input: task,
        emit: opts.emit,
        signal: opts.signal,
        focusJobId: jobId,
        parentRunId: runId,
        parentCallId: callId,
        depth: depth + 1,
        timeZone: opts.timeZone,
      });
      return res.output || `(The ${agent} returned no report.)`;
    } catch (err) {
      if (err instanceof AbortError || opts.signal.aborted) throw err;
      throw new ToolError(`The ${agent} subagent failed: ${(err as Error).message}`);
    }
  };

  const buildRequestMessages = async (): Promise<ChatMessage[]> => {
    const extra = opts.extraInfo ? await opts.extraInfo() : [];
    const draftSystem = `${basePrompt}\n\n${systemInfoBlock({ now: now(), timeZone: opts.timeZone, context: contextInfo(0, window), extra })}`;
    const estimate = estimateTokens([{ role: 'system', content: draftSystem }, ...messages], specs);
    const info = systemInfoBlock({
      now: now(),
      timeZone: opts.timeZone,
      context: contextInfo(estimate, window),
      lastPromptTokens,
      extra,
    });
    return [{ role: 'system', content: `${basePrompt}\n\n${info}` }, ...messages];
  };

  try {
    let output = '';
    let nudges = 0;
    for (let step = 1; ; step++) {
      if (opts.signal.aborted) throw new AbortError();
      const finalStep = step > deps.config.maxSteps[opts.agent];
      if (finalStep) {
        messages.push({
          role: 'user',
          content: '[System] Step limit reached. Do not call any more tools — give your final answer now based on what you have.',
        });
      }
      messages = compactMessages(messages, window, { reserveTokens: estimateTokens([], specs) + 4000 }).messages;
      const requestMessages = await buildRequestMessages();
      const estimated = estimateTokens(requestMessages, finalStep ? [] : specs);
      opts.emit({ type: 'llm_start', runId, step, context: contextInfo(estimated, window, lastPromptTokens), at: now().toISOString() });

      const res = await deps.llm.chat({
        model,
        messages: requestMessages,
        tools: finalStep ? undefined : specs,
        signal: opts.signal,
        onThinking: (delta) => opts.emit({ type: 'thinking', runId, delta }),
        onText: (delta) => opts.emit({ type: 'text', runId, delta }),
      });
      lastPromptTokens = res.usage.promptTokens ?? lastPromptTokens;
      opts.emit({
        type: 'llm_end',
        runId,
        step,
        usage: res.usage,
        context: contextInfo(estimated, window, res.usage.promptTokens),
        at: now().toISOString(),
      });

      const toolCalls = finalStep ? [] : res.toolCalls;
      messages.push({
        role: 'assistant',
        content: res.content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) {
        if (!res.content.trim() && nudges < 2) {
          // Some reasoning models leave the answer inside their thinking. Ask again explicitly.
          nudges++;
          messages.push({
            role: 'user',
            content: '[System] Your last reply had no visible text. Write your answer now as plain message text (not only in your thinking), or call a tool.',
          });
          continue;
        }
        output = res.content.trim();
        if (!output && depth > 0 && res.thinking.trim()) {
          // Last resort for subagents: hand the caller the model's final reasoning rather than nothing.
          output = `(Reply recovered from the ${opts.agent}'s reasoning)\n${res.thinking.trim().slice(-4000)}`;
        }
        break;
      }

      for (const call of toolCalls) {
        if (opts.signal.aborted) throw new AbortError();
        const callId = call.id || randomUUID();
        const name = call.function.name;
        const rawArgs = call.function.arguments;
        opts.emit({ type: 'tool_call', runId, callId, name, args: rawArgs, at: now().toISOString() });
        const started = Date.now();
        let content: string;
        let ok = true;
        const def = byName.get(name);
        try {
          if (!def) throw new ToolError(`Unknown tool "${name}". Available tools: ${[...byName.keys()].join(', ')}`);
          const ctx: ToolContext = {
            userId: opts.userId,
            agent: opts.agent,
            runId,
            callId,
            repo: deps.repo,
            skills: deps.skills,
            web: deps.web,
            emit: opts.emit,
            signal: opts.signal,
            focusJobId: opts.focusJobId,
            callAgent,
            pageCount: deps.pageCount ? (jobId) => deps.pageCount!(opts.userId, jobId) : undefined,
          };
          content = serializeResult(await executeTool(def, rawArgs, ctx));
        } catch (err) {
          if (err instanceof AbortError || opts.signal.aborted) throw new AbortError();
          ok = false;
          const msg = err instanceof Error ? err.message : String(err);
          content = `Error: ${msg}`;
          if (!(err instanceof ToolError)) console.error(`[tool ${name}]`, err);
        }
        opts.emit({ type: 'tool_result', runId, callId, name, ok, result: content, ms: Date.now() - started });
        messages.push({ role: 'tool', content, tool_name: name, ...(call.id ? { tool_call_id: call.id } : {}) });
      }
    }

    opts.emit({ type: 'agent_end', runId, status: 'done', output, at: now().toISOString() });
    return { runId, output, messages };
  } catch (err) {
    const aborted = err instanceof AbortError || opts.signal.aborted;
    opts.emit({
      type: 'agent_end',
      runId,
      status: aborted ? 'aborted' : 'error',
      output: '',
      error: aborted ? 'Stopped' : (err as Error).message,
      at: now().toISOString(),
    });
    throw aborted ? new AbortError() : err;
  }
}
