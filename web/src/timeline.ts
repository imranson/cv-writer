import type { StreamEvent } from '../../src/agents/types';
import type { AgentName } from '../../src/config';
import type { ContextUsage } from '../../src/store/types';

export interface TextNode {
  kind: 'text';
  id: string;
  agent: AgentName;
  content: string;
  thinking: string;
  streaming: boolean;
}

export interface ToolNode {
  kind: 'tool';
  id: string;
  agent: AgentName;
  name: string;
  args: unknown;
  status: 'running' | 'ok' | 'error';
  result?: string;
  durationMs?: number;
  /** Subagent run started by this tool call (callWriter / callCritic). */
  subrun?: RunNode;
}

export interface RunNode {
  kind: 'run';
  id: string;
  agent: AgentName;
  task?: string;
  status: 'running' | 'done' | 'error';
  error?: string;
  usage?: ContextUsage;
  children: Array<TextNode | ToolNode | RunNode>;
}

export type TopNode =
  | { kind: 'user'; id: string; content: string; at: string }
  | { kind: 'error'; id: string; message: string }
  | RunNode;

export interface Timeline {
  nodes: TopNode[];
  runs: Map<string, RunNode>;
  tools: Map<string, ToolNode>;
  seq: number;
}

export function createTimeline(): Timeline {
  return { nodes: [], runs: new Map(), tools: new Map(), seq: 0 };
}

/** Folds one streamed or persisted event into the timeline tree (mutates and returns it). */
export function applyEvent(t: Timeline, e: StreamEvent): Timeline {
  switch (e.type) {
    case 'user_message':
      t.nodes.push({ kind: 'user', id: `u${t.seq++}`, content: e.content, at: e.at });
      break;
    case 'agent_start': {
      const run: RunNode = { kind: 'run', id: e.runId, agent: e.agent, task: e.task, status: 'running', children: [] };
      t.runs.set(e.runId, run);
      const parent = e.parentRunId ? t.runs.get(e.parentRunId) : undefined;
      if (!parent) {
        t.nodes.push(run);
        break;
      }
      const pendingCall = [...parent.children]
        .reverse()
        .find((c): c is ToolNode => c.kind === 'tool' && c.status === 'running' && !c.subrun);
      if (pendingCall) pendingCall.subrun = run;
      else parent.children.push(run);
      break;
    }
    case 'delta': {
      const run = t.runs.get(e.runId);
      if (!run) break;
      let last = run.children[run.children.length - 1];
      if (!last || last.kind !== 'text' || !last.streaming) {
        last = { kind: 'text', id: `t${t.seq++}`, agent: e.agent, content: '', thinking: '', streaming: true };
        run.children.push(last);
      }
      if (e.content) last.content += e.content;
      if (e.thinking) last.thinking += e.thinking;
      break;
    }
    case 'assistant_message': {
      const run = t.runs.get(e.runId);
      if (!run) break;
      const last = run.children[run.children.length - 1];
      if (last?.kind === 'text' && last.streaming) {
        last.content = e.content;
        last.thinking = e.thinking ?? last.thinking;
        last.streaming = false;
      } else {
        run.children.push({ kind: 'text', id: `t${t.seq++}`, agent: e.agent, content: e.content, thinking: e.thinking ?? '', streaming: false });
      }
      break;
    }
    case 'tool_call': {
      const run = t.runs.get(e.runId);
      if (!run) break;
      endStreaming(run);
      const node: ToolNode = { kind: 'tool', id: e.callId, agent: e.agent, name: e.name, args: e.args, status: 'running' };
      t.tools.set(e.callId, node);
      run.children.push(node);
      break;
    }
    case 'tool_result': {
      const node = t.tools.get(e.callId);
      if (!node) break;
      node.status = e.ok ? 'ok' : 'error';
      node.result = e.result;
      node.durationMs = e.durationMs;
      break;
    }
    case 'usage': {
      const run = t.runs.get(e.runId);
      if (run) run.usage = e.usage;
      break;
    }
    case 'agent_end': {
      const run = t.runs.get(e.runId);
      if (!run) break;
      endStreaming(run);
      run.status = e.error ? 'error' : 'done';
      run.error = e.error;
      break;
    }
    case 'error':
      t.nodes.push({ kind: 'error', id: `e${t.seq++}`, message: e.message });
      break;
    case 'data_changed':
      break;
  }
  return t;
}

function endStreaming(run: RunNode) {
  const last = run.children[run.children.length - 1];
  if (last?.kind === 'text') last.streaming = false;
}

/** Marks every still-running node as stopped (used when a stream ends unexpectedly). */
export function settle(t: Timeline): void {
  for (const run of t.runs.values()) {
    if (run.status === 'running') run.status = 'error';
    endStreaming(run);
  }
  for (const tool of t.tools.values()) if (tool.status === 'running') tool.status = 'error';
}

export function summarizeArgs(args: unknown, max = 90): string {
  if (args === null || typeof args !== 'object') return '';
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v);
    return `${k}: ${text.length > 40 ? `${text.slice(0, 37)}…` : text}`;
  });
  const joined = parts.join(', ');
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined;
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}
