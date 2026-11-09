import type { Activity, AgentRun, LlmStep, Step, ToolStep } from '../shared/activity.js';
import type { ContextInfo } from '../shared/events.js';
import { renderMarkdown } from '../shared/markdown.js';
import { fmtMs, fmtNum, h } from './dom.js';

/** Remembers which <details> the user opened/closed so live re-renders don't reset them. */
export class OpenState {
  private state = new Map<string, boolean>();
  isOpen(key: string, fallback: boolean): boolean {
    return this.state.get(key) ?? fallback;
  }
  set(key: string, open: boolean) {
    this.state.set(key, open);
  }
}

function details(open: OpenState, key: string, defaultOpen: boolean, summary: (Node | string)[], body: () => (Node | string | null)[], cls = '') {
  const el = h('details', { class: cls, 'data-key': key }) as HTMLDetailsElement;
  el.open = open.isOpen(key, defaultOpen);
  el.append(h('summary', {}, ...summary));
  // Lazily build heavy bodies (big tool results) only when open.
  const fill = () => {
    if (el.dataset.filled) return;
    el.dataset.filled = '1';
    for (const n of body()) if (n) el.append(n);
  };
  if (el.open) fill();
  el.addEventListener('toggle', () => {
    open.set(key, el.open);
    if (el.open) fill();
  });
  return el;
}

const AGENT_LABEL: Record<string, string> = { coordinator: 'Coordinator', writer: 'Writer', critic: 'Critic' };

export function contextMeter(ctx: ContextInfo | undefined, compact = false): HTMLElement {
  if (!ctx) return h('span.ctx-meter.empty', 'ctx –');
  const pct = Math.min(100, ctx.percent);
  const level = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
  const title =
    `Estimated context: ~${ctx.estimatedTokens.toLocaleString()} of ${ctx.window.toLocaleString()} tokens (${ctx.percent}%)` +
    (ctx.promptTokens ? `\nModel-reported prompt tokens (last call): ${ctx.promptTokens.toLocaleString()}` : '');
  return h(
    'span.ctx-meter',
    { title, class: level },
    h('span.ctx-bar', h('span.ctx-fill', { style: { width: `${Math.max(pct, 1)}%` } })),
    h('span.ctx-label', compact ? `${ctx.percent}%` : `~${fmtNum(ctx.estimatedTokens)} / ${fmtNum(ctx.window)} (${ctx.percent}%)`),
  );
}

function pretty(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(value, null, 2);
}

function argsPreview(args: unknown): string {
  let obj: unknown = args;
  if (typeof args === 'string') {
    try {
      obj = JSON.parse(args);
    } catch {
      return args.slice(0, 80);
    }
  }
  if (!obj || typeof obj !== 'object') return '';
  const parts = Object.entries(obj as Record<string, unknown>).map(([k, v]) => {
    const s = typeof v === 'string' ? JSON.stringify(v.length > 40 ? `${v.slice(0, 40)}…` : v) : JSON.stringify(v);
    return `${k}: ${s && s.length > 50 ? `${s.slice(0, 50)}…` : s}`;
  });
  return parts.join(', ');
}

function runDuration(run: AgentRun): number | undefined {
  if (!run.startedAt) return undefined;
  const end = run.endedAt ? Date.parse(run.endedAt) : Date.now();
  return end - Date.parse(run.startedAt);
}

export function renderRun(activity: Activity, run: AgentRun, open: OpenState): HTMLElement {
  const el = h('div.run', { class: `agent-${run.agent} status-${run.status}` });
  const head = h(
    'div.run-head',
    h('span.agent-badge', { class: run.agent }, AGENT_LABEL[run.agent] ?? run.agent),
    h('span.run-model', run.model),
    h('span.run-status', { class: run.status }, run.status === 'running' ? 'working…' : run.status),
    h('span.run-meta', fmtMs(runDuration(run))),
    contextMeter(run.context, true),
    h(
      'span.run-meta',
      { title: 'Model-reported tokens: prompt (summed over calls) / generated' },
      `${fmtNum(run.totals.promptTokens)} in · ${fmtNum(run.totals.evalTokens)} out · ${run.totals.llmCalls} calls · ${run.totals.toolCalls} tools`,
    ),
  );
  el.append(head);

  const meta = h('div.run-details');
  meta.append(
    details(open, `${run.runId}:task`, false, [run.depth === 0 ? 'User message' : 'Task from caller'], () => [h('pre.task', run.task)], 'mini'),
    details(open, `${run.runId}:sys`, false, [`System prompt (${run.systemPrompt.length.toLocaleString()} chars) · tools: ${run.tools.length}`], () => [
      h('pre.sys', run.systemPrompt),
      h('div.tool-list', run.tools.map((t) => h('code', t))),
    ], 'mini'),
  );
  el.append(meta);

  const steps = h('div.steps');
  run.steps.forEach((s, i) => steps.append(renderStep(activity, run, s, i, open)));
  el.append(steps);
  if (run.error && run.status !== 'aborted') el.append(h('div.run-error', `Error: ${run.error}`));
  return el;
}

function renderStep(activity: Activity, run: AgentRun, step: Step, index: number, open: OpenState): HTMLElement {
  const key = `${run.runId}:${index}`;
  if (step.kind === 'skill') return h('div.step.skill', `📘 Loaded skill `, h('code', step.name));
  if (step.kind === 'llm') return renderLlmStep(run, step, key, open);
  return renderToolStep(activity, run, step, key, open);
}

function renderLlmStep(run: AgentRun, step: LlmStep, key: string, open: OpenState): HTMLElement {
  const el = h('div.step.llm');
  const u = step.usage;
  el.append(
    h(
      'div.step-head',
      h('span.step-title', `LLM call ${step.step}`),
      h('span.step-meta', `context ~${fmtNum(step.context.estimatedTokens)} tok (${step.context.percent}%)`),
      u?.promptTokens !== undefined ? h('span.step-meta', `prompt ${fmtNum(u.promptTokens)} · out ${fmtNum(u.evalTokens)}`) : null,
      u?.durationMs ? h('span.step-meta', fmtMs(u.durationMs)) : null,
      !step.done ? h('span.spinner') : null,
    ),
  );
  if (step.thinking) {
    el.append(
      details(open, `${key}:think`, !step.done, [`💭 Thinking (${step.thinking.length.toLocaleString()} chars)`], () => [h('pre.thinking', step.thinking)], 'thinking-box'),
    );
  }
  if (step.text) el.append(h('div.step-text.md', { html: renderMarkdown(step.text) }));
  return el;
}

function renderToolStep(activity: Activity, run: AgentRun, step: ToolStep, key: string, open: OpenState): HTMLElement {
  const state = step.ok === undefined ? 'pending' : step.ok ? 'ok' : 'err';
  const el = h('div.step.tool', { class: state });
  el.append(
    details(
      open,
      `${key}:tool`,
      false,
      [
        h('span.tool-name', `🔧 ${step.name}`),
        h('span.tool-args', `(${argsPreview(step.args)})`),
        h('span.tool-state', { class: state }, state === 'pending' ? 'running…' : state === 'ok' ? `✓ ${fmtMs(step.ms)}` : `✗ ${fmtMs(step.ms)}`),
      ],
      () => [
        h('div.io-label', 'Arguments'),
        h('pre.io', pretty(step.args)),
        h('div.io-label', `Result${step.result ? ` (${step.result.length.toLocaleString()} chars)` : ''}`),
        h('pre.io', step.result === undefined ? '…' : pretty(step.result)),
      ],
    ),
  );
  if (step.childRunIds.length) {
    const kids = h('div.children');
    for (const id of step.childRunIds) {
      const child = activity.runs[id];
      if (child) kids.append(renderRun(activity, child, open));
    }
    el.append(kids);
  }
  return el;
}

export function renderActivity(activity: Activity, open: OpenState): HTMLElement {
  const root = h('div.activity');
  for (const id of activity.rootRunIds) {
    const run = activity.runs[id];
    if (run) root.append(renderRun(activity, run, open));
  }
  if (!activity.rootRunIds.length) root.append(h('div.muted', 'No agent activity yet.'));
  return root;
}

export function activitySummary(activity: Activity): string {
  const runs = Object.values(activity.runs);
  const tools = runs.reduce((n, r) => n + r.totals.toolCalls, 0);
  const calls = runs.reduce((n, r) => n + r.totals.llmCalls, 0);
  const agents = new Set(runs.map((r) => r.agent));
  const root = activity.runs[activity.rootRunIds[0]];
  const dur = root ? runDuration(root) : undefined;
  return `${runs.length} agent run${runs.length === 1 ? '' : 's'} (${[...agents].map((a) => AGENT_LABEL[a]).join(', ')}) · ${calls} LLM calls · ${tools} tool calls${dur ? ` · ${fmtMs(dur)}` : ''}`;
}

/** Text the coordinator has streamed so far in its latest LLM call (the live answer). */
export function liveAnswer(activity: Activity): string {
  const root = activity.runs[activity.rootRunIds[0]];
  if (!root) return '';
  for (let i = root.steps.length - 1; i >= 0; i--) {
    const s = root.steps[i];
    if (s.kind === 'llm') return s.text;
    if (s.kind === 'tool') return '';
  }
  return '';
}

/** Per-agent context table: the latest context reading of every run. */
export function contextTable(activity: Activity): HTMLElement {
  const rows = Object.values(activity.runs).map((r) =>
    h(
      'tr',
      h('td', h('span.agent-badge', { class: r.agent }, AGENT_LABEL[r.agent])),
      h('td', r.model),
      h('td', contextMeter(r.context)),
      h('td', r.context?.promptTokens !== undefined ? fmtNum(r.context.promptTokens) : '–'),
      h('td', `${fmtNum(r.totals.promptTokens)} / ${fmtNum(r.totals.evalTokens)}`),
      h('td', r.status),
    ),
  );
  return h(
    'table.ctx-table',
    h('thead', h('tr', h('th', 'Agent'), h('th', 'Model'), h('th', 'Context (estimated)'), h('th', 'Last prompt (reported)'), h('th', 'Tokens in/out'), h('th', 'Status'))),
    h('tbody', rows.length ? rows : h('tr', h('td', { colspan: 6, class: 'muted' }, 'No runs yet'))),
  );
}
