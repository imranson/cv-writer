/**
 * Folds the agent event stream into a tree of agent runs. Used by the server (to persist each
 * turn's activity in the chat session JSON) and by the browser (to render it live) — same code,
 * same result.
 */
import type { AgentEvent, AgentType, ContextInfo, Usage } from './events.js';

export interface LlmStep {
  kind: 'llm';
  step: number;
  thinking: string;
  text: string;
  context: ContextInfo;
  usage?: Usage;
  done: boolean;
}

export interface ToolStep {
  kind: 'tool';
  callId: string;
  name: string;
  args: unknown;
  result?: string;
  ok?: boolean;
  ms?: number;
  childRunIds: string[];
}

export interface SkillStep {
  kind: 'skill';
  name: string;
}

export type Step = LlmStep | ToolStep | SkillStep;

export interface AgentRun {
  runId: string;
  agent: AgentType;
  model: string;
  parentRunId?: string;
  parentCallId?: string;
  depth: number;
  task: string;
  systemPrompt: string;
  tools: string[];
  status: 'running' | 'done' | 'error' | 'aborted';
  output?: string;
  error?: string;
  startedAt: string;
  endedAt?: string;
  steps: Step[];
  context?: ContextInfo;
  totals: { promptTokens: number; evalTokens: number; llmCalls: number; toolCalls: number };
}

export interface Activity {
  runs: Record<string, AgentRun>;
  rootRunIds: string[];
}

export const emptyActivity = (): Activity => ({ runs: {}, rootRunIds: [] });

function lastLlmStep(run: AgentRun): LlmStep | undefined {
  for (let i = run.steps.length - 1; i >= 0; i--) {
    const s = run.steps[i];
    if (s.kind === 'llm') return s;
  }
  return undefined;
}

function findTool(run: AgentRun | undefined, callId: string | undefined): ToolStep | undefined {
  if (!run || !callId) return undefined;
  return run.steps.find((s): s is ToolStep => s.kind === 'tool' && s.callId === callId);
}

/** Applies one event (mutates and returns `activity`). Unknown runs are ignored. */
export function applyEvent(activity: Activity, e: AgentEvent): Activity {
  switch (e.type) {
    case 'agent_start': {
      activity.runs[e.runId] = {
        runId: e.runId,
        agent: e.agent,
        model: e.model,
        parentRunId: e.parentRunId,
        parentCallId: e.parentCallId,
        depth: e.depth,
        task: e.task,
        systemPrompt: e.systemPrompt,
        tools: e.tools,
        status: 'running',
        startedAt: e.at,
        steps: [],
        totals: { promptTokens: 0, evalTokens: 0, llmCalls: 0, toolCalls: 0 },
      };
      const parentTool = findTool(e.parentRunId ? activity.runs[e.parentRunId] : undefined, e.parentCallId);
      if (parentTool) parentTool.childRunIds.push(e.runId);
      else activity.rootRunIds.push(e.runId);
      break;
    }
    case 'llm_start': {
      const run = activity.runs[e.runId];
      if (!run) break;
      run.steps.push({ kind: 'llm', step: e.step, thinking: '', text: '', context: e.context, done: false });
      run.context = e.context;
      run.totals.llmCalls++;
      break;
    }
    case 'thinking':
    case 'text': {
      const run = activity.runs[e.runId];
      const step = run && lastLlmStep(run);
      if (!step) break;
      if (e.type === 'thinking') step.thinking += e.delta;
      else step.text += e.delta;
      break;
    }
    case 'llm_end': {
      const run = activity.runs[e.runId];
      const step = run && lastLlmStep(run);
      if (!run || !step) break;
      step.done = true;
      step.usage = e.usage;
      step.context = e.context;
      run.context = e.context;
      run.totals.promptTokens += e.usage.promptTokens ?? 0;
      run.totals.evalTokens += e.usage.evalTokens ?? 0;
      break;
    }
    case 'tool_call': {
      const run = activity.runs[e.runId];
      if (!run) break;
      run.steps.push({ kind: 'tool', callId: e.callId, name: e.name, args: e.args, childRunIds: [] });
      run.totals.toolCalls++;
      break;
    }
    case 'tool_result': {
      const step = findTool(activity.runs[e.runId], e.callId);
      if (!step) break;
      step.result = e.result;
      step.ok = e.ok;
      step.ms = e.ms;
      break;
    }
    case 'skill_loaded': {
      activity.runs[e.runId]?.steps.push({ kind: 'skill', name: e.skill });
      break;
    }
    case 'agent_end': {
      const run = activity.runs[e.runId];
      if (!run) break;
      run.status = e.status;
      run.output = e.output;
      run.error = e.error;
      run.endedAt = e.at;
      for (const s of run.steps) if (s.kind === 'llm') s.done = true;
      break;
    }
    default:
      break;
  }
  return activity;
}

/** Marks any still-running runs as aborted (e.g. after a crash or disconnect). */
export function finalizeActivity(activity: Activity, status: 'aborted' | 'error' = 'aborted'): Activity {
  for (const run of Object.values(activity.runs)) {
    if (run.status === 'running') {
      run.status = status;
      run.endedAt = new Date().toISOString();
    }
  }
  return activity;
}
