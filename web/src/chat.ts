import { agentLabel, resultHighlight, toolIcon, toolLabel } from './activity.ts';
import { api } from './api.ts';
import { formatTokens, h, mount, toast } from './dom.ts';
import { renderMarkdown } from './markdown.ts';
import { bus, state } from './state.ts';
import type { ContextUsage, Message, ServerEvent } from './types.ts';
import { openSession, refreshJobs, refreshSessions, setSessionJob } from './actions.ts';

const STARTERS = [
  { label: 'Build my profile from scratch', text: "Hi! I'd like to build my CV profile from scratch. Please interview me." },
  { label: 'I have a job listing', text: "I have a job I'd like to apply for. I'll paste the listing next." },
  { label: 'Import my existing CV', text: "Here's my existing CV — please use it to build my profile:\n\n" },
];

/** Context window indicator: tokens used vs the coordinator model's limit. */
export function renderContextMeter(el: HTMLElement, ctx: ContextUsage | undefined): void {
  if (!ctx || !ctx.limit) {
    mount(el);
    return;
  }
  const pct = Math.min(100, (ctx.tokens / ctx.limit) * 100);
  const level = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
  el.title = `${ctx.estimated ? 'Estimated' : 'Reported'} context use of the coach: ${ctx.tokens.toLocaleString()} of ${ctx.limit.toLocaleString()} tokens. Older messages are summarised automatically near the limit.`;
  mount(
    el,
    h('span', { class: 'ctx-label' }, 'Context'),
    h('span', { class: `ctx-bar ctx-${level}`, role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': pct.toFixed(0) }, h('span', { style: `width:${Math.max(pct, 1).toFixed(1)}%` })),
    h('span', { class: 'ctx-text' }, `${ctx.estimated ? '~' : ''}${formatTokens(ctx.tokens)} / ${formatTokens(ctx.limit)} · ${pct < 1 ? '<1' : pct.toFixed(0)}%`),
  );
}

interface Chip {
  el: HTMLElement;
  sub: HTMLElement;
  name: string;
  args: Record<string, unknown>;
}

export class ChatView {
  readonly el: HTMLElement;
  private readonly titleEl = h('div', { class: 'chat-title' });
  private readonly jobSelect = h('select', { class: 'job-select', 'aria-label': 'Active job' });
  private readonly meter = h('div', { class: 'ctx-meter' });
  private readonly compactBtn = h('button', { class: 'btn btn-ghost btn-sm', title: 'Summarise older messages to free up context' }, 'Compact');
  private readonly list = h('div', { class: 'messages', 'aria-live': 'polite' });
  private readonly input = h('textarea', { class: 'composer-input', rows: 1, placeholder: 'Message your CV coach…', title: 'Enter to send · Shift+Enter for a new line' });
  private readonly sendBtn = h('button', { class: 'btn btn-primary' }, 'Send');
  private readonly status = h('div', { class: 'composer-status' });

  private renderedId: string | null = null;

  // Live-turn state
  private liveText: HTMLElement | null = null;
  private liveBuffer = '';
  private liveThinking: HTMLElement | null = null;
  private thinkingBuffer = '';
  private chips = new Map<string, Chip>();
  private currentParent: Chip | null = null;
  private renderScheduled = false;

  constructor() {
    this.el = h(
      'section',
      { class: 'chat' },
      h('header', { class: 'chat-header' }, this.titleEl, this.jobSelect),
      this.list,
      h(
        'div',
        { class: 'composer' },
        h('div', { class: 'composer-box' }, this.input, this.sendBtn),
        h('div', { class: 'composer-footer' }, this.status, h('span', { class: 'spacer' }), this.compactBtn, this.meter),
      ),
    );

    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.submit();
      }
    });
    this.input.addEventListener('input', () => this.autosize());
    this.sendBtn.addEventListener('click', () => (state.running ? void this.stop() : void this.submit()));
    this.jobSelect.addEventListener('change', () => void setSessionJob(this.jobSelect.value || null));
    this.compactBtn.addEventListener('click', () => void this.compact());

    bus.on('session', () => {
      // Mid-turn updates (e.g. the coach selected a job) must not wipe the live transcript.
      if (state.running && state.session?.id === this.renderedId) this.renderHeader();
      else this.render();
    });
    bus.on('jobs', () => this.renderJobSelect());
    bus.on('running', (running) => this.renderRunning(running));
    bus.on('compose', ({ text, send }) => {
      this.input.value = text;
      this.autosize();
      if (send) void this.submit();
      else this.input.focus();
    });
  }

  private autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(this.input.scrollHeight, 220)}px`;
  }

  private renderRunning(running: boolean) {
    this.sendBtn.textContent = running ? 'Stop' : 'Send';
    this.sendBtn.classList.toggle('btn-danger', running);
    this.sendBtn.classList.toggle('btn-primary', !running);
    this.compactBtn.disabled = running;
    this.status.textContent = running ? 'Working…' : '';
  }

  private renderJobSelect() {
    const current = state.session?.jobId ?? '';
    mount(
      this.jobSelect,
      h('option', { value: '' }, 'No job selected'),
      state.jobs.map((j) => h('option', { value: j.id, selected: j.id === current }, `${j.title} — ${j.company}`)),
    );
    this.jobSelect.value = current;
    this.jobSelect.disabled = !state.session;
  }

  private renderHeader() {
    const s = state.session;
    this.titleEl.textContent = s?.title ?? 'CV Writer';
    this.renderJobSelect();
    renderContextMeter(this.meter, s?.context);
    this.compactBtn.hidden = !s || s.messages.length - s.contextStart < 8;
  }

  render() {
    const s = state.session;
    this.renderedId = s?.id ?? null;
    this.renderHeader();
    this.resetLive();
    if (!s) {
      mount(this.list, this.welcome());
      return;
    }
    const nodes: HTMLElement[] = [];
    if (s.contextStart > 0) {
      nodes.push(h('div', { class: 'divider', title: s.summary }, `Earlier messages (${s.contextStart}) were summarised to save context`));
    }
    const msgs = s.messages;
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i]!;
      if (i === s.contextStart && i > 0) nodes.push(h('div', { class: 'divider divider-faint' }, 'Current context starts here'));
      if (m.role === 'user') nodes.push(this.userBubble(m.content));
      else if (m.role === 'assistant') {
        if (m.content.trim()) nodes.push(this.assistantBubble(m.content, m.thinking));
        else if (m.thinking && !m.toolCalls?.length) nodes.push(this.assistantBubble('', m.thinking));
        let j = i + 1;
        for (const call of m.toolCalls ?? []) {
          const result = msgs[j]?.role === 'tool' ? msgs[j++] : undefined;
          nodes.push(this.historicChip(call.name, call.arguments, result).el);
        }
        i = j - 1;
      }
    }
    if (!msgs.length) nodes.push(this.welcome());
    mount(this.list, nodes);
    this.scrollToEnd(true);
    if (s.running) toast('This conversation is still running in the background.');
  }

  private welcome(): HTMLElement {
    return h(
      'div',
      { class: 'welcome' },
      h('h2', null, 'Your CV coach'),
      h(
        'p',
        null,
        "I'll interview you to build a thorough profile, tailor a CV to the job you want, have it critiqued, and help you polish it until it's ready to submit.",
      ),
      h(
        'div',
        { class: 'starters' },
        STARTERS.map((s) => h('button', { class: 'starter', onclick: () => bus.emit('compose', { text: s.text, send: !s.text.endsWith('\n\n') }) }, s.label)),
      ),
    );
  }

  private userBubble(text: string): HTMLElement {
    return h('div', { class: 'msg msg-user' }, h('div', { class: 'bubble' }, text));
  }

  private assistantBubble(text: string, thinking?: string): HTMLElement {
    return h(
      'div',
      { class: 'msg msg-assistant' },
      thinking ? h('details', { class: 'thinking' }, h('summary', null, 'Reasoning'), h('div', { class: 'thinking-body' }, thinking)) : null,
      text ? h('div', { class: 'bubble md', html: renderMarkdown(text) }) : null,
    );
  }

  private chip(name: string, args: Record<string, unknown>, agent: 'coordinator' | 'writer' | 'critic' = 'coordinator'): Chip {
    const sub = h('div', { class: 'chip-sub' });
    const el = h(
      'div',
      { class: `chip chip-running chip-${agent}` },
      h('div', { class: 'chip-row' }, h('span', { class: 'chip-icon' }, toolIcon(name)), h('span', { class: 'chip-label' }, toolLabel(name, args)), h('span', { class: 'chip-state' })),
      sub,
    );
    return { el, sub, name, args };
  }

  private finishChip(chip: Chip, name: string, args: Record<string, unknown>, ok: boolean, output: string) {
    chip.el.classList.remove('chip-running');
    chip.el.classList.add(ok ? 'chip-ok' : 'chip-error');
    const label = chip.el.querySelector('.chip-label');
    if (label) label.textContent = toolLabel(name, args, true);
    const stateEl = chip.el.querySelector('.chip-state')!;
    stateEl.textContent = (ok ? resultHighlight(name, output) : 'failed') ?? '';
    if (output.trim()) {
      const details = h('details', { class: 'chip-details' }, h('summary', null, 'Details'), h('pre', null, output));
      chip.el.appendChild(details);
    }
  }

  private historicChip(name: string, args: Record<string, unknown>, result?: Message): Chip {
    const chip = this.chip(name, args);
    this.finishChip(chip, name, args, Boolean(result && !result.content.startsWith('Error:')), result?.content ?? '');
    return chip;
  }

  private resetLive() {
    this.liveText = null;
    this.liveBuffer = '';
    this.liveThinking = null;
    this.thinkingBuffer = '';
    this.chips.clear();
    this.currentParent = null;
  }

  private scrollToEnd(force = false) {
    const nearBottom = this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 160;
    if (force || nearBottom) this.list.scrollTop = this.list.scrollHeight;
  }

  private scheduleRender() {
    if (this.renderScheduled) return;
    this.renderScheduled = true;
    requestAnimationFrame(() => {
      this.renderScheduled = false;
      if (this.liveText) this.liveText.innerHTML = renderMarkdown(this.liveBuffer);
      if (this.liveThinking) this.liveThinking.textContent = this.thinkingBuffer;
      this.scrollToEnd();
    });
  }

  private handleEvent(e: ServerEvent) {
    switch (e.type) {
      case 'thinking':
        if (e.agent !== 'coordinator') return;
        if (!this.liveThinking) {
          this.liveThinking = h('div', { class: 'thinking-body' });
          this.list.appendChild(h('div', { class: 'msg msg-assistant' }, h('details', { class: 'thinking live' }, h('summary', null, 'Thinking…'), this.liveThinking)));
        }
        this.thinkingBuffer += e.delta;
        this.scheduleRender();
        return;
      case 'text':
        if (e.agent !== 'coordinator') return;
        if (!this.liveText) {
          this.liveText = h('div', { class: 'bubble md' });
          this.list.appendChild(h('div', { class: 'msg msg-assistant' }, this.liveText));
        }
        this.liveBuffer += e.delta;
        this.scheduleRender();
        return;
      case 'tool_start': {
        if (e.agent === 'coordinator') {
          const chip = this.chip(e.name, e.args);
          this.chips.set(e.callId, chip);
          this.currentParent = chip;
          this.list.appendChild(chip.el);
        } else {
          const row = h('div', { class: 'sub-row sub-running', dataset: { id: e.callId } }, h('span', { class: 'sub-agent' }, agentLabel(e.agent)), ` ${toolLabel(e.name, e.args)}`);
          this.currentParent?.sub.appendChild(row);
        }
        this.scrollToEnd();
        return;
      }
      case 'tool_end': {
        if (e.agent === 'coordinator') {
          const chip = this.chips.get(e.callId);
          if (chip) this.finishChip(chip, chip.name, chip.args, e.ok, e.preview);
          this.currentParent = null;
        } else {
          const row = this.currentParent?.sub.querySelector<HTMLElement>(`[data-id="${CSS.escape(e.callId)}"]`);
          if (row) {
            row.classList.remove('sub-running');
            row.classList.add(e.ok ? 'sub-ok' : 'sub-error');
            row.lastChild!.textContent = ` ${toolLabel(e.name, {}, true)}${e.ok ? '' : ' (failed)'}`;
          }
        }
        return;
      }
      case 'message':
        if (e.message.role === 'assistant') {
          // The streamed text becomes the final message; the next step starts a new bubble.
          if (this.liveText) this.liveText.innerHTML = renderMarkdown(e.message.content);
          else if (e.message.content.trim()) this.list.appendChild(this.assistantBubble(e.message.content));
          const summary = this.liveThinking?.parentElement?.querySelector('summary');
          if (summary) summary.textContent = 'Reasoning';
          this.liveText = null;
          this.liveBuffer = '';
          this.liveThinking = null;
          this.thinkingBuffer = '';
        }
        if (state.session) state.session.messages.push(e.message);
        this.scrollToEnd();
        return;
      case 'context':
        if (state.session) state.session.context = e.context;
        renderContextMeter(this.meter, e.context);
        return;
      case 'session':
        if (state.session && state.session.id === e.session.id) {
          const jobChanged = state.session.jobId !== e.session.jobId;
          state.session.title = e.session.title;
          state.session.jobId = e.session.jobId;
          this.titleEl.textContent = e.session.title;
          if (jobChanged) {
            void refreshJobs().then(() => bus.emit('session'));
          }
        }
        void refreshSessions();
        return;
      case 'artifact':
        bus.emit('artifact', { kind: e.kind, jobId: e.jobId });
        return;
      case 'compacted':
        toast(`Summarised ${e.compacted} older messages to free up context.`);
        return;
      case 'error':
        this.list.appendChild(h('div', { class: 'msg-error' }, `Something went wrong: ${e.message}`));
        this.scrollToEnd(true);
        return;
      case 'stopped':
        this.list.appendChild(h('div', { class: 'divider' }, 'Stopped'));
        return;
      default:
        return;
    }
  }

  async submit() {
    const text = this.input.value.trim();
    if (!text || state.running) return;
    if (!state.session) {
      await openSession(null);
      if (!state.session) return;
    }
    const session = state.session!;
    this.input.value = '';
    this.autosize();
    this.list.querySelector('.welcome')?.remove();
    this.list.appendChild(this.userBubble(text));
    this.scrollToEnd(true);
    this.resetLive();
    state.running = true;
    bus.emit('running', true);
    try {
      await api.send(session.id, text, (e) => {
        if (e.type === 'message' && e.message.role === 'user') {
          session.messages.push(e.message);
          return;
        }
        if (state.session?.id === session.id) this.handleEvent(e);
      });
    } catch (err) {
      toast((err as Error).message, 'error');
      this.input.value = text;
    } finally {
      state.running = false;
      bus.emit('running', false);
      this.compactBtn.hidden = !state.session || state.session.messages.length - state.session.contextStart < 8;
      void refreshJobs();
      void refreshSessions();
    }
  }

  async stop() {
    if (state.session) await api.stop(state.session.id).catch(() => undefined);
  }

  async compact() {
    if (!state.session) return;
    this.compactBtn.disabled = true;
    try {
      state.session = await api.compact(state.session.id);
      toast('Older messages summarised.');
      this.render();
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      this.compactBtn.disabled = false;
    }
  }
}
