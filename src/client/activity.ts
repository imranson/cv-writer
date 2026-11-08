import type { AgentEvent } from '../agents/events.js';

/** Builds a tree of agent runs (coordinator → writer → critic) from a flat event stream. */

export interface ContextGauge {
  used: number;
  window: number;
  estimated: boolean;
}

export interface ToolItem {
  kind: 'tool';
  callId: string;
  name: string;
  args: unknown;
  result?: string;
  ok?: boolean;
  durationMs?: number;
  /** Subagent runs started while this tool was executing (callWriter / callCritic). */
  children: RunNode[];
}

export interface StepItem {
  kind: 'llm';
  step: number;
  content: string;
  thinking?: string;
  toolCalls: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs: number;
}

export interface NoteItem {
  kind: 'note';
  level: 'info' | 'error';
  text: string;
}

export type RunItem = ToolItem | StepItem | NoteItem;

export interface RunNode {
  runId: string;
  parentRunId?: string;
  agent: string;
  model: string;
  task: string;
  at: string;
  status: 'running' | 'ok' | 'error';
  items: RunItem[];
  context?: ContextGauge;
  peakContext?: ContextGauge;
  result?: string;
  steps?: number;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
}

export interface Turn {
  userMessage?: string;
  at?: string;
  runs: RunNode[];
  notes: NoteItem[];
}

const ENTITY_LABEL: Record<string, string> = {
  profile: 'Profile updated',
  job: 'Job saved',
  cv: 'CV updated',
  css: 'Stylesheet updated',
  preferences: 'CV preferences updated',
};

export function buildTurns(events: AgentEvent[]): Turn[] {
  const turns: Turn[] = [];
  const runs = new Map<string, RunNode>();
  const openTools = new Map<string, ToolItem[]>(); // runId → tools in progress
  let current: Turn | undefined;
  const turn = () => (current ??= (turns.push({ runs: [], notes: [] }), turns[turns.length - 1]));

  for (const e of events) {
    switch (e.type) {
      case 'user_message':
        current = { userMessage: e.content, at: e.at, runs: [], notes: [] };
        turns.push(current);
        break;
      case 'run_start': {
        const node: RunNode = { runId: e.runId, parentRunId: e.parentRunId, agent: e.agent, model: e.model, task: e.task, at: e.at, status: 'running', items: [] };
        runs.set(e.runId, node);
        const parent = e.parentRunId ? runs.get(e.parentRunId) : undefined;
        const host = parent ? openTools.get(parent.runId)?.at(-1) : undefined;
        if (host) host.children.push(node);
        else if (parent) parent.items.push({ kind: 'tool', callId: `${e.runId}-host`, name: 'subagent', args: {}, children: [node] });
        else turn().runs.push(node);
        break;
      }
      case 'context': {
        const run = runs.get(e.runId);
        if (!run) break;
        run.context = { used: e.usedTokens, window: e.contextWindow, estimated: e.estimated };
        if (!run.peakContext || e.usedTokens >= run.peakContext.used) run.peakContext = run.context;
        break;
      }
      case 'llm_end': {
        const run = runs.get(e.runId);
        if (!run) break;
        if (e.content.trim() || e.thinking?.trim()) {
          run.items.push({
            kind: 'llm',
            step: e.step,
            content: e.content,
            thinking: e.thinking,
            toolCalls: e.toolCalls.length,
            promptTokens: e.usage?.promptTokens,
            completionTokens: e.usage?.completionTokens,
            durationMs: e.durationMs,
          });
        }
        break;
      }
      case 'tool_start': {
        const run = runs.get(e.runId);
        if (!run) break;
        const item: ToolItem = { kind: 'tool', callId: e.callId, name: e.name, args: e.args, children: [] };
        run.items.push(item);
        openTools.set(e.runId, [...(openTools.get(e.runId) ?? []), item]);
        break;
      }
      case 'tool_end': {
        const run = runs.get(e.runId);
        if (!run) break;
        const open = openTools.get(e.runId) ?? [];
        const item =
          open.find((t) => t.callId === e.callId) ??
          (run.items.find((t) => t.kind === 'tool' && t.callId === e.callId) as ToolItem | undefined);
        if (item) {
          item.result = e.result;
          item.ok = e.ok;
          item.durationMs = e.durationMs;
        }
        openTools.set(e.runId, open.filter((t) => t.callId !== e.callId));
        break;
      }
      case 'run_end': {
        const run = runs.get(e.runId);
        if (!run) break;
        run.status = e.ok ? 'ok' : 'error';
        run.result = e.result;
        run.steps = e.steps;
        run.promptTokens = e.usage.promptTokens;
        run.completionTokens = e.usage.completionTokens;
        run.durationMs = e.durationMs;
        break;
      }
      case 'data_changed':
        turn().notes.push({ kind: 'note', level: 'info', text: ENTITY_LABEL[e.entity] ?? 'Data updated' });
        break;
      case 'error': {
        const note: NoteItem = { kind: 'note', level: 'error', text: e.message };
        const run = e.runId ? runs.get(e.runId) : undefined;
        if (run) run.items.push(note);
        else turn().notes.push(note);
        break;
      }
      default:
        break;
    }
  }
  return turns;
}

/** Latest context gauge of the most recent coordinator run (for the chat header). */
export function latestCoordinatorContext(events: AgentEvent[]): ContextGauge | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'context' && e.agent === 'coordinator') return { used: e.usedTokens, window: e.contextWindow, estimated: e.estimated };
  }
  return undefined;
}

export function totals(events: AgentEvent[]): { promptTokens: number; completionTokens: number; runs: number; tools: number } {
  let promptTokens = 0;
  let completionTokens = 0;
  let runCount = 0;
  let tools = 0;
  for (const e of events) {
    if (e.type === 'run_end') {
      promptTokens += e.usage.promptTokens;
      completionTokens += e.usage.completionTokens;
      runCount++;
    } else if (e.type === 'tool_end') tools++;
  }
  return { promptTokens, completionTokens, runs: runCount, tools };
}
