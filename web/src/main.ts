import type { StreamEvent } from '../../src/agents/types';
import type { AgentName } from '../../src/config';
import type { ContextUsage, JobSummary, PublicUser, SessionSummary } from '../../src/store/types';
import { ApiError, api, type AgentInfo, type DoneEvent } from './api';
import { clear, h, pretty, type Child } from './dom';
import { renderMarkdown } from './markdown';
import { applyEvent, createTimeline, formatTokens, settle, summarizeArgs, type RunNode, type TextNode, type Timeline, type ToolNode } from './timeline';

type Tab = 'cv' | 'css' | 'preferences' | 'job' | 'profile' | 'activity';
const TABS: { id: Tab; label: string }[] = [
  { id: 'cv', label: 'CV' },
  { id: 'css', label: 'CSS' },
  { id: 'preferences', label: 'Preferences' },
  { id: 'job', label: 'Job' },
  { id: 'profile', label: 'Profile' },
  { id: 'activity', label: 'Activity' },
];
const AGENT_LABEL: Record<AgentName, string> = { coordinator: 'Coordinator', writer: 'Writer', critic: 'Critic' };

const store = {
  get(key: string) {
    try {
      return localStorage.getItem(key) ?? undefined;
    } catch {
      return undefined;
    }
  },
  set(key: string, value: string | undefined) {
    try {
      if (value === undefined) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch {
      // storage unavailable
    }
  },
};

const state = {
  user: undefined as PublicUser | undefined,
  agents: [] as AgentInfo[],
  sessions: [] as SessionSummary[],
  sessionId: undefined as string | undefined,
  timeline: createTimeline() as Timeline,
  log: [] as StreamEvent[],
  usage: {} as Partial<Record<AgentName, ContextUsage>>,
  running: false,
  abort: undefined as AbortController | undefined,
  jobs: [] as JobSummary[],
  jobId: undefined as string | undefined,
  tab: (store.get('cvw.tab') as Tab) || 'cv',
  previewMode: 'html' as 'html' | 'pdf',
  open: new Set<string>(),
  dirty: new Set<string>(),
};

const app = document.getElementById('app')!;
let els: {
  sessions: HTMLElement;
  jobs: HTMLElement;
  transcript: HTMLElement;
  meters: HTMLElement;
  tabs: HTMLElement;
  panel: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  status: HTMLElement;
};

// ---- auth ------------------------------------------------------------------

function renderAuth(mode: 'login' | 'register' = 'login', message = '') {
  const error = h('p', { class: 'form-error', role: 'alert' }, message);
  const email = h('input', { type: 'email', name: 'email', placeholder: 'you@example.com', required: true, autocomplete: 'email' });
  const name = h('input', { type: 'text', name: 'name', placeholder: 'Your name', autocomplete: 'name' });
  const password = h('input', {
    type: 'password',
    name: 'password',
    placeholder: 'At least 8 characters',
    required: true,
    minlength: '8',
    autocomplete: mode === 'login' ? 'current-password' : 'new-password',
  });
  const form = h(
    'form',
    {
      class: 'auth-card',
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        error.textContent = '';
        try {
          const { user } =
            mode === 'login' ? await api.login(email.value, password.value) : await api.register(email.value, name.value, password.value);
          state.user = user;
          await startApp();
        } catch (err) {
          error.textContent = (err as Error).message;
        }
      },
    },
    h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'CV Writer'),
    h('h1', null, mode === 'login' ? 'Sign in' : 'Create an account'),
    h('p', { class: 'muted' }, 'One coordinator agent takes you from a blank page to a tailored, print-ready CV.'),
    h('label', null, 'Email', email),
    mode === 'register' && h('label', null, 'Name', name),
    h('label', null, 'Password', password),
    error,
    h('button', { class: 'primary', type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account'),
    h(
      'p',
      { class: 'muted small' },
      mode === 'login' ? 'New here? ' : 'Already registered? ',
      h('a', { href: '#', onclick: (e: Event) => (e.preventDefault(), renderAuth(mode === 'login' ? 'register' : 'login')) }, mode === 'login' ? 'Create an account' : 'Sign in'),
    ),
  );
  clear(app, h('main', { class: 'auth' }, form));
  email.focus();
}

// ---- shell -----------------------------------------------------------------

async function startApp() {
  const input = h('textarea', {
    id: 'composer',
    rows: 3,
    placeholder: 'Message the coordinator… (Enter to send, Shift+Enter for a new line)',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void sendOrStop();
      }
    },
  });
  const send = h('button', { class: 'primary', id: 'send', onclick: () => void sendOrStop() }, 'Send');
  els = {
    sessions: h('ul', { class: 'list', id: 'sessions' }),
    jobs: h('ul', { class: 'list', id: 'jobs' }),
    transcript: h('div', { class: 'transcript', id: 'transcript' }),
    meters: h('div', { class: 'meters', id: 'meters', 'aria-label': 'Context window usage' }),
    tabs: h('div', { class: 'tabs', role: 'tablist' }),
    panel: h('div', { class: 'panel-body', id: 'panel' }),
    input,
    send,
    status: h('span', { class: 'status muted small', id: 'status' }),
  };

  clear(
    app,
    h(
      'div',
      { class: 'shell' },
      h(
        'header',
        { class: 'topbar' },
        h('div', { class: 'brand' }, h('span', { class: 'logo' }), 'CV Writer'),
        els.meters,
        h(
          'div',
          { class: 'account' },
          h('span', { class: 'muted small', title: state.user?.email }, state.user?.name || state.user?.email),
          h('button', { class: 'ghost small', onclick: logout }, 'Sign out'),
        ),
      ),
      h(
        'aside',
        { class: 'sidebar' },
        h('div', { class: 'side-head' }, h('h2', null, 'Chats'), h('button', { class: 'ghost small', id: 'new-chat', onclick: newChat }, '+ New')),
        els.sessions,
        h('div', { class: 'side-head' }, h('h2', null, 'Jobs'), h('button', { class: 'ghost small', id: 'new-job', onclick: newJobForm }, '+ New')),
        els.jobs,
      ),
      h(
        'section',
        { class: 'chat' },
        els.transcript,
        h('div', { class: 'composer' }, input, h('div', { class: 'composer-row' }, els.status, send)),
      ),
      h('section', { class: 'panel' }, els.tabs, els.panel),
    ),
  );

  const [system, sessions, jobs] = await Promise.all([api.system(), api.sessions(), api.jobs()]);
  state.agents = system.agents;
  state.sessions = sessions.sessions;
  state.jobs = jobs.jobs;
  const savedJob = store.get(jobKey());
  state.jobId = state.jobs.find((j) => j.id === savedJob)?.id ?? state.jobs[0]?.id;
  renderSessions();
  renderJobs();
  renderTabs();
  renderMeters();
  const savedSession = store.get(sessionKey());
  const initial = state.sessions.find((s) => s.id === savedSession) ?? state.sessions[0];
  if (initial) await openSession(initial.id);
  else renderTranscript();
  void renderPanel();
  input.focus();
}

const jobKey = () => `cvw.job.${state.user?.id}`;
const sessionKey = () => `cvw.session.${state.user?.id}`;

async function logout() {
  state.abort?.abort();
  await api.logout().catch(() => {});
  state.user = undefined;
  renderAuth();
}

// ---- sessions ----------------------------------------------------------------

function renderSessions() {
  clear(
    els.sessions,
    state.sessions.length === 0 && h('li', { class: 'empty muted small' }, 'No conversations yet'),
    state.sessions.map((s) =>
      h(
        'li',
        { class: s.id === state.sessionId ? 'active' : '' },
        h('button', { class: 'item', onclick: () => void openSession(s.id), title: s.title }, s.title),
        h(
          'button',
          {
            class: 'icon',
            title: 'Delete conversation',
            'aria-label': `Delete ${s.title}`,
            onclick: async () => {
              if (!confirm(`Delete “${s.title}”?`)) return;
              await api.deleteSession(s.id).catch(showError);
              if (state.sessionId === s.id) resetTranscript();
              await refreshSessions();
            },
          },
          '×',
        ),
      ),
    ),
  );
}

async function refreshSessions() {
  state.sessions = (await api.sessions()).sessions;
  renderSessions();
}

function resetTranscript() {
  state.sessionId = undefined;
  state.timeline = createTimeline();
  state.log = [];
  state.usage = {};
  store.set(sessionKey(), undefined);
  renderTranscript();
  renderMeters();
}

async function newChat() {
  if (state.running) return;
  resetTranscript();
  renderSessions();
  els.input.focus();
}

async function openSession(id: string) {
  if (state.running) return;
  const { session, running } = await api.session(id);
  state.sessionId = session.id;
  store.set(sessionKey(), session.id);
  state.timeline = createTimeline();
  state.log = [];
  for (const e of session.events) {
    applyEvent(state.timeline, e);
    state.log.push(e);
  }
  settle(state.timeline);
  state.usage = { ...session.usage };
  renderSessions();
  renderTranscript(true);
  renderMeters();
  if (state.tab === 'activity') void renderPanel();
  setStatus(running ? 'This conversation is running in another tab.' : '');
}

// ---- jobs --------------------------------------------------------------------

function renderJobs() {
  clear(
    els.jobs,
    state.jobs.length === 0 && h('li', { class: 'empty muted small' }, 'No jobs yet — paste a posting in the chat'),
    state.jobs.map((j) =>
      h(
        'li',
        { class: j.id === state.jobId ? 'active' : '' },
        h(
          'button',
          { class: 'item', onclick: () => selectJob(j.id), title: `${j.title} — ${j.company}` },
          h('span', { class: 'job-title' }, j.title || 'Untitled role'),
          h('span', { class: 'muted small' }, j.company || '—'),
        ),
      ),
    ),
  );
}

function selectJob(id: string | undefined) {
  if (state.jobId === id) return;
  state.jobId = id;
  store.set(jobKey(), id);
  state.dirty.clear();
  renderJobs();
  void renderPanel();
}

async function refreshJobs() {
  state.jobs = (await api.jobs()).jobs;
  if (state.jobId && !state.jobs.some((j) => j.id === state.jobId)) state.jobId = state.jobs[0]?.id;
  renderJobs();
}

function newJobForm() {
  const title = h('input', { placeholder: 'Job title', required: true });
  const company = h('input', { placeholder: 'Company' });
  const form = h(
    'form',
    {
      class: 'inline-form',
      onsubmit: async (e: Event) => {
        e.preventDefault();
        const { job } = await api.createJob({ title: title.value, company: company.value });
        await refreshJobs();
        selectJob(job.id);
      },
    },
    title,
    company,
    h('div', { class: 'row' }, h('button', { class: 'primary small', type: 'submit' }, 'Add job'), h('button', { class: 'ghost small', type: 'button', onclick: renderJobs }, 'Cancel')),
  );
  els.jobs.prepend(h('li', null, form));
  title.focus();
}

// ---- context meters ------------------------------------------------------------

function renderMeters() {
  clear(
    els.meters,
    state.agents.map((a) => {
      const usage = state.usage[a.agent];
      const window = usage?.window || a.contextWindow;
      const used = usage?.used ?? 0;
      const pct = window ? Math.min(100, (used / window) * 100) : 0;
      const level = pct >= 80 ? 'high' : pct >= 50 ? 'mid' : 'low';
      return h(
        'div',
        {
          class: `meter ${level}`,
          'data-agent': a.agent,
          title: `${AGENT_LABEL[a.agent]} · ${a.model}\n${used.toLocaleString()} / ${window.toLocaleString()} tokens${usage?.estimated ? ' (estimated)' : ''}\nprompt ${usage?.promptTokens ?? 0} · output ${usage?.outputTokens ?? 0}`,
        },
        h('span', { class: 'meter-label' }, AGENT_LABEL[a.agent]),
        h('span', { class: 'meter-bar' }, h('span', { class: 'meter-fill', style: `width:${pct.toFixed(1)}%` })),
        h('span', { class: 'meter-value' }, usage ? `${formatTokens(used)} / ${formatTokens(window)} · ${pct.toFixed(1)}%` : `— / ${formatTokens(window)}`),
      );
    }),
  );
}

// ---- transcript ----------------------------------------------------------------

let renderQueued = false;
function scheduleTranscript() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderTranscript();
  });
}

function renderTranscript(forceBottom = false) {
  const el = els.transcript;
  const nearBottom = forceBottom || el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  if (state.timeline.nodes.length === 0) {
    clear(
      el,
      h(
        'div',
        { class: 'welcome' },
        h('h2', null, 'Hi! I’m your CV coordinator.'),
        h('p', { class: 'muted' }, 'Tell me about the role you’re going for, paste a job posting or link, or share your current CV. I’ll interview you, brief the writer and critic, and keep everything in the panels on the right.'),
        h(
          'div',
          { class: 'suggestions' },
          ['Help me write a CV from scratch', 'Here is a job posting I want to apply for:', 'Review my CV for the selected job'].map((s) =>
            h('button', { class: 'chip', onclick: () => ((els.input.value = s), els.input.focus()) }, s),
          ),
        ),
      ),
    );
    return;
  }
  clear(
    el,
    state.timeline.nodes.map((node) => {
      if (node.kind === 'user') return h('div', { class: 'msg user' }, node.content);
      if (node.kind === 'error') return h('div', { class: 'msg error', role: 'alert' }, `⚠ ${node.message}`);
      return renderRunChildren(node, true);
    }),
  );
  if (nearBottom) el.scrollTop = el.scrollHeight;
}

function renderRunChildren(run: RunNode, top: boolean): HTMLElement {
  const box = h('div', { class: top ? 'run' : 'run nested' });
  for (const child of run.children) {
    if (child.kind === 'text') box.append(renderText(child, top));
    else if (child.kind === 'tool') box.append(renderTool(child));
    else box.append(renderSubrun(child));
  }
  if (top && run.status === 'running' && !run.children.some((c) => c.kind === 'text' && c.streaming)) {
    box.append(h('div', { class: 'typing muted small' }, h('span', { class: 'dots' }), `${AGENT_LABEL[run.agent]} is working…`));
  }
  return box;
}

function renderText(node: TextNode, top: boolean): HTMLElement {
  return h(
    'div',
    { class: `msg ${top ? 'assistant' : 'sub'}${node.streaming ? ' streaming' : ''}` },
    node.thinking && detailsFor(`think-${node.id}`, h('summary', { class: 'muted small' }, 'Thinking'), h('pre', { class: 'thinking' }, node.thinking)),
    node.content && h('div', { class: 'md', html: renderMarkdown(node.content) }),
  );
}

function renderTool(node: ToolNode): HTMLElement {
  const icon = node.status === 'running' ? '◌' : node.status === 'ok' ? '✓' : '✕';
  const details = detailsFor(
    `tool-${node.id}`,
    h(
      'summary',
      null,
      h('span', { class: `tool-status ${node.status}` }, icon),
      h('span', { class: `agent-badge ${node.agent}` }, AGENT_LABEL[node.agent]),
      h('code', { class: 'tool-name' }, node.name),
      h('span', { class: 'tool-args muted' }, summarizeArgs(node.args)),
      node.durationMs !== undefined && h('span', { class: 'muted small duration' }, formatMs(node.durationMs)),
    ),
    h('div', { class: 'tool-body' }, h('h4', null, 'Arguments'), h('pre', null, pretty(node.args)), node.result !== undefined && [h('h4', null, 'Result'), h('pre', null, pretty(node.result))]),
  );
  details.className = `tool ${node.status}`;
  return h('div', { class: 'tool-wrap', 'data-tool': node.name }, details, node.subrun && renderSubrun(node.subrun));
}

function renderSubrun(run: RunNode): HTMLElement {
  const usage = run.usage ? `${formatTokens(run.usage.used)} / ${formatTokens(run.usage.window)} ctx` : '';
  return h(
    'div',
    { class: `subrun ${run.agent} ${run.status}`, 'data-agent': run.agent },
    h(
      'div',
      { class: 'subrun-head' },
      h('span', { class: `agent-badge ${run.agent}` }, `${AGENT_LABEL[run.agent]} subagent`),
      h('span', { class: 'muted small' }, run.status === 'running' ? 'working…' : run.status === 'error' ? `failed: ${run.error ?? 'stopped'}` : 'done'),
      usage && h('span', { class: 'muted small' }, usage),
    ),
    run.task && detailsFor(`task-${run.id}`, h('summary', { class: 'muted small' }, 'Brief'), h('pre', null, run.task)),
    renderRunChildren(run, false),
  );
}

function detailsFor(id: string, summary: HTMLElement, ...body: Child[]): HTMLDetailsElement {
  const d = h('details', { open: state.open.has(id) }, summary, ...body);
  d.addEventListener('toggle', () => (d.open ? state.open.add(id) : state.open.delete(id)));
  return d;
}

function formatMs(ms: number) {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

// ---- sending -------------------------------------------------------------------

function setStatus(text: string) {
  els.status.textContent = text;
}

function setRunning(running: boolean) {
  state.running = running;
  els.send.textContent = running ? 'Stop' : 'Send';
  els.send.classList.toggle('danger', running);
  els.input.disabled = running;
  document.body.classList.toggle('busy', running);
}

async function sendOrStop() {
  if (state.running) {
    state.abort?.abort();
    return;
  }
  const content = els.input.value.trim();
  if (!content) return;
  try {
    if (!state.sessionId) {
      const { session } = await api.createSession();
      state.sessionId = session.id;
      store.set(sessionKey(), session.id);
      await refreshSessions();
    }
  } catch (err) {
    return showError(err);
  }
  els.input.value = '';
  const userEvent: StreamEvent = { type: 'user_message', at: new Date().toISOString(), content };
  applyEvent(state.timeline, userEvent);
  state.log.push(userEvent);
  renderTranscript(true);
  setRunning(true);
  setStatus('Coordinator is thinking…');
  const abort = new AbortController();
  state.abort = abort;
  try {
    await api.sendMessage(state.sessionId!, content, state.jobId, onStreamEvent, abort.signal);
  } catch (err) {
    if (!abort.signal.aborted) {
      applyEvent(state.timeline, { type: 'error', at: new Date().toISOString(), message: (err as Error).message });
    }
  } finally {
    settle(state.timeline);
    setRunning(false);
    setStatus(abort.signal.aborted ? 'Stopped.' : '');
    renderTranscript();
    await refreshSessions().catch(() => {});
    els.input.focus();
  }
}

function onStreamEvent(e: StreamEvent | DoneEvent) {
  if (e.type === 'done') return;
  applyEvent(state.timeline, e);
  if (e.type !== 'delta') state.log.push(e);
  switch (e.type) {
    case 'usage':
      state.usage[e.agent] = e.usage;
      renderMeters();
      break;
    case 'tool_call':
      setStatus(`${AGENT_LABEL[e.agent]} → ${e.name}`);
      break;
    case 'agent_start':
      setStatus(`${AGENT_LABEL[e.agent]} started`);
      break;
    case 'data_changed':
      onDataChanged(e.kind, e.jobId);
      break;
  }
  if (e.type !== 'delta' && state.tab === 'activity') schedulePanel();
  scheduleTranscript();
}

let pendingRefresh = new Set<string>();
let pendingJob: string | undefined;
let refreshTimer: number | undefined;
function onDataChanged(kind: string, jobId?: string) {
  pendingRefresh.add(kind);
  if (jobId && kind !== 'job') pendingJob = jobId;
  if (jobId && kind === 'job') pendingJob ??= jobId;
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(async () => {
    const kinds = pendingRefresh;
    pendingRefresh = new Set();
    if (kinds.has('job')) await refreshJobs().catch(() => {});
    // Follow the job the agents are working on so the user sees changes live.
    const target = pendingJob;
    pendingJob = undefined;
    // Follow only when the user has no unsaved edits in the panel.
    if (target && state.jobs.some((j) => j.id === target) && target !== state.jobId && state.dirty.size === 0) selectJob(target);
    else void renderPanel(true);
  }, 250);
}

function showError(err: unknown) {
  if (err instanceof ApiError && err.status === 401) return renderAuth('login', 'Your session expired. Please sign in again.');
  setStatus(`⚠ ${(err as Error).message}`);
}

// ---- right panel -----------------------------------------------------------------

function renderTabs() {
  clear(
    els.tabs,
    TABS.map((t) =>
      h(
        'button',
        {
          role: 'tab',
          class: t.id === state.tab ? 'tab active' : 'tab',
          'aria-selected': String(t.id === state.tab),
          'data-tab': t.id,
          onclick: () => {
            state.tab = t.id;
            store.set('cvw.tab', t.id);
            renderTabs();
            void renderPanel();
          },
        },
        t.label,
      ),
    ),
  );
}

let panelQueued = false;
function schedulePanel() {
  if (panelQueued) return;
  panelQueued = true;
  setTimeout(() => {
    panelQueued = false;
    void renderPanel(true);
  }, 300);
}

let panelSeq = 0;
let pdfUrl: string | undefined;

async function renderPanel(fromServer = false) {
  const seq = ++panelSeq;
  const tab = state.tab;
  const panel = els.panel;
  const stale = () => seq !== panelSeq;
  try {
    if (tab === 'activity') return renderActivity();
    if (tab === 'profile') {
      if (fromServer && state.dirty.has('profile')) return markStale();
      const { profile } = await api.profile();
      if (stale()) return;
      return clear(panel, jsonEditor('profile', 'Career profile (JSON). The coordinator fills this in as you talk.', profile, async (v) => void (await api.saveProfile(v as any))));
    }
    const jobId = state.jobId;
    if (!jobId) {
      return clear(panel, h('div', { class: 'empty-panel muted' }, 'No job selected. Create one with “+ New”, or paste a job posting into the chat.'));
    }
    if (tab === 'job') {
      if (fromServer && state.dirty.has('job')) return markStale();
      const { job } = await api.job(jobId);
      if (stale()) return;
      return clear(
        panel,
        jsonEditor('job', 'Target job (JSON). Put the full posting text in "description".', job, async (v) => {
          await api.updateJob(jobId, v as any);
          await refreshJobs();
        }),
        h('div', { class: 'danger-zone' }, h('button', {
          class: 'ghost danger small',
          onclick: async () => {
            if (!confirm('Delete this job together with its CV, preferences and CSS?')) return;
            await api.deleteJob(jobId);
            await refreshJobs();
            void renderPanel();
          },
        }, 'Delete job, CV, preferences and CSS')),
      );
    }
    if (tab === 'preferences') {
      if (fromServer && state.dirty.has('preferences')) return markStale();
      const { preferences } = await api.preferences(jobId);
      if (stale()) return;
      return clear(panel, jsonEditor('preferences', 'Preferences for this CV (page size, length, tone, sections).', preferences, async (v) => void (await api.savePreferences(jobId, v as any))));
    }
    if (tab === 'css') {
      if (fromServer && state.dirty.has('css')) return markStale();
      const { css } = await api.css(jobId);
      if (stale()) return;
      return clear(panel, textEditor('css', 'Raw CSS used for the preview and the PDF.', css, async (v) => void (await api.saveCss(jobId, v))));
    }
    if (tab === 'cv') return await renderCv(jobId, stale);
  } catch (err) {
    if (!stale()) clear(panel, h('div', { class: 'empty-panel error' }, (err as Error).message));
  }
}

function markStale() {
  els.panel.querySelector('.stale-note')?.classList.remove('hidden');
}

async function renderCv(jobId: string, stale: () => boolean) {
  const job = state.jobs.find((j) => j.id === jobId);
  const toolbar = h(
    'div',
    { class: 'toolbar' },
    h('div', { class: 'seg' }, (['html', 'pdf'] as const).map((m) =>
      h('button', { class: state.previewMode === m ? 'active' : '', onclick: () => ((state.previewMode = m), void renderPanel()) }, m === 'html' ? 'Preview' : 'PDF'),
    )),
    h('span', { class: 'muted small pages' }),
    h('span', { class: 'spacer' }),
    h('a', { class: 'button ghost small', href: `/api/jobs/${jobId}/cv.pdf`, target: '_blank', rel: 'noopener' }, 'Open PDF'),
    h('a', { class: 'button primary small', href: `/api/jobs/${jobId}/cv.pdf?download=1` }, 'Download PDF'),
  );
  if (state.previewMode === 'html') {
    const res = await fetch(`/api/jobs/${jobId}/document`, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Could not load CV (HTTP ${res.status})`);
    const doc = await res.text();
    if (stale()) return;
    const frame = h('iframe', { class: 'cv-frame', title: `CV preview for ${job?.title ?? 'job'}`, sandbox: '' });
    frame.srcdoc = doc;
    clear(els.panel, toolbar, h('div', { class: 'paper' }, frame));
  } else {
    clear(els.panel, toolbar, h('div', { class: 'empty-panel muted' }, 'Rendering PDF with Playwright…'));
    const { blob, pages } = await api.pdf(jobId);
    if (stale()) return;
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(blob);
    toolbar.querySelector('.pages')!.textContent = `${pages} page${pages === 1 ? '' : 's'}`;
    clear(els.panel, toolbar, h('iframe', { class: 'pdf-frame', title: 'PDF preview', src: pdfUrl }));
  }
}

function editorShell(key: string, hint: string, area: HTMLTextAreaElement, save: () => Promise<void>, reload: () => void) {
  const msg = h('span', { class: 'muted small' });
  area.addEventListener('input', () => {
    state.dirty.add(key);
    msg.textContent = 'Unsaved changes';
  });
  return h(
    'div',
    { class: 'editor' },
    h('p', { class: 'muted small' }, hint),
    h('div', { class: 'stale-note hidden' }, 'An agent changed this while you were editing. ', h('button', { class: 'ghost small', onclick: reload }, 'Discard mine and reload')),
    area,
    h(
      'div',
      { class: 'row' },
      h('button', {
        class: 'primary small',
        onclick: async () => {
          try {
            await save();
            state.dirty.delete(key);
            msg.textContent = 'Saved ✓';
          } catch (err) {
            msg.textContent = `⚠ ${(err as Error).message}`;
          }
        },
      }, 'Save'),
      h('button', { class: 'ghost small', onclick: reload }, 'Revert'),
      msg,
    ),
  );
}

function jsonEditor(key: string, hint: string, value: unknown, save: (v: unknown) => Promise<void>) {
  const area = h('textarea', { class: 'code', spellcheck: 'false', 'data-editor': key });
  area.value = JSON.stringify(value, null, 2);
  return editorShell(key, hint, area, async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(area.value);
    } catch (err) {
      throw new Error(`Invalid JSON: ${(err as Error).message}`);
    }
    await save(parsed);
  }, () => {
    state.dirty.delete(key);
    void renderPanel();
  });
}

function textEditor(key: string, hint: string, value: string, save: (v: string) => Promise<void>) {
  const area = h('textarea', { class: 'code', spellcheck: 'false', 'data-editor': key });
  area.value = value;
  return editorShell(key, hint, area, () => save(area.value), () => {
    state.dirty.delete(key);
    void renderPanel();
  });
}

function renderActivity() {
  const rows = state.log.filter((e) => e.type !== 'delta');
  if (rows.length === 0) return clear(els.panel, h('div', { class: 'empty-panel muted' }, 'Tool calls, subagent runs and context usage for this conversation appear here.'));
  const describe = (e: StreamEvent): [string, string, string] => {
    switch (e.type) {
      case 'user_message': return ['you', 'message', e.content];
      case 'agent_start': return [e.agent, 'start', e.parentRunId ? 'subagent run' : 'run'];
      case 'assistant_message': return [e.agent, 'reply', e.content];
      case 'tool_call': return [e.agent, `→ ${e.name}`, summarizeArgs(e.args, 140)];
      case 'tool_result': return [e.agent, `${e.ok ? '✓' : '✕'} ${e.name}`, `${formatMs(e.durationMs)} · ${e.result.slice(0, 160)}`];
      case 'usage': return [e.agent, 'context', `${e.usage.used.toLocaleString()} / ${e.usage.window.toLocaleString()} tokens (prompt ${e.usage.promptTokens}, output ${e.usage.outputTokens})`];
      case 'agent_end': return [e.agent, e.error ? 'failed' : 'end', e.error ?? ''];
      case 'data_changed': return ['data', 'changed', `${e.kind}${e.jobId ? ` · job ${e.jobId}` : ''}`];
      case 'error': return ['system', 'error', e.message];
      default: return ['', e.type, ''];
    }
  };
  clear(
    els.panel,
    h(
      'ol',
      { class: 'activity' },
      rows.map((e) => {
        const [who, what, detail] = describe(e);
        return h('li', { class: `act ${e.type}` },
          h('time', { class: 'muted small' }, new Date(e.at).toLocaleTimeString()),
          h('span', { class: `agent-badge ${who}` }, who),
          h('strong', null, what),
          h('span', { class: 'act-detail' }, detail));
      }),
    ),
  );
  els.panel.scrollTop = els.panel.scrollHeight;
}

// ---- boot ------------------------------------------------------------------------

async function boot() {
  try {
    state.user = (await api.me()).user;
    await startApp();
  } catch (err) {
    renderAuth('login', err instanceof ApiError && err.status === 401 ? '' : (err as Error).message);
  }
}

void boot();
