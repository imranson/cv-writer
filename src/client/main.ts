import type { AgentEvent, DataEntity } from '../agents/events.js';
import { buildCvDocument } from '../lib/html.js';
import { buildTurns, latestCoordinatorContext, totals, type ContextGauge, type RunItem, type RunNode } from './activity.js';
import { api, attachStream, readEventStream, sendMessage } from './api.js';
import { fmtDuration, fmtTokens, h, prettyJson, relativeTime, replace } from './dom.js';
import { renderMarkdown } from './markdown.js';

// ---------------------------------------------------------------- types & state

type Tab = 'activity' | 'profile' | 'job' | 'cv' | 'css' | 'preferences';

interface Account {
  id: string;
  email: string;
  name: string;
  active?: boolean;
}
interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
}
interface Message {
  role: 'user' | 'assistant';
  content: string;
  at?: string;
}
interface SessionDetail {
  id: string;
  title: string;
  messages: Message[];
  activity: AgentEvent[];
  busy: boolean;
}
interface JobSummary {
  id: string;
  title: string;
  company: string;
  cvChars: number;
  updatedAt: string;
}
interface JobDetail {
  job: { id: string; data: Record<string, unknown>; updatedAt: string };
  cv: { html: string; css: string; preferences: Record<string, unknown>; updatedAt: string };
}
interface AgentInfo {
  name: string;
  model: string;
  contextWindow: number;
  tools: string[];
  skills: { name: string; description: string }[];
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'activity', label: 'Activity' },
  { id: 'profile', label: 'Profile' },
  { id: 'job', label: 'Job' },
  { id: 'cv', label: 'CV' },
  { id: 'css', label: 'CSS' },
  { id: 'preferences', label: 'Preferences' },
];

const state = {
  user: null as Account | null,
  accounts: [] as Account[],
  allowRegistration: true,
  addingAccount: false,
  sessions: [] as SessionSummary[],
  sessionId: null as string | null,
  session: null as SessionDetail | null,
  liveEvents: [] as AgentEvent[],
  streaming: false,
  draft: '',
  runAgents: new Map<string, string>(),
  liveText: new Map<string, string>(),
  jobs: [] as JobSummary[],
  jobId: null as string | null,
  jobDetail: null as JobDetail | null,
  profile: {} as Record<string, unknown>,
  tab: 'activity' as Tab,
  updatedTabs: new Set<Tab>(),
  dirty: new Set<Tab>(),
  editorText: {} as Partial<Record<Tab, string>>,
  openDetails: new Set<string>(),
  agents: [] as AgentInfo[],
  confirmDelete: null as string | null,
};

const root = document.getElementById('app')!;
const els = {} as {
  sessions: HTMLElement;
  jobs: HTMLElement;
  account: HTMLElement;
  title: HTMLElement;
  ctx: HTMLElement;
  messages: HTMLElement;
  input: HTMLTextAreaElement;
  send: HTMLButtonElement;
  stop: HTMLButtonElement;
  tabs: HTMLElement;
  body: HTMLElement;
  toasts: HTMLElement;
};

// ---------------------------------------------------------------- helpers

function toast(message: string, kind: 'info' | 'error' = 'info') {
  const t = h('div', { class: `toast ${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  els.toasts?.appendChild(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

async function guard<T>(fn: () => Promise<T>): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 401) {
      state.user = null;
      renderAuth();
      return undefined;
    }
    toast(e.message, 'error');
    return undefined;
  }
}

let frame = 0;
const pending = new Set<'messages' | 'inspector' | 'header'>();
function schedule(...parts: ('messages' | 'inspector' | 'header')[]) {
  parts.forEach((p) => pending.add(p));
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    if (pending.has('messages')) renderMessages();
    if (pending.has('header')) renderHeader();
    if (pending.has('inspector') && (state.tab === 'activity' || !state.streaming)) renderInspector();
    pending.clear();
  });
}

const allEvents = () => [...(state.session?.activity ?? []), ...state.liveEvents];

function gauge(g: ContextGauge | undefined, label?: string) {
  const pct = g && g.window ? Math.min(100, (g.used / g.window) * 100) : 0;
  const level = pct >= 85 ? 'crit' : pct >= 60 ? 'warn' : 'ok';
  return h(
    'div',
    {
      class: `gauge ${level}`,
      title: g ? `${g.used.toLocaleString()} of ${g.window.toLocaleString()} tokens${g.estimated ? ' (estimated)' : ' (reported by model)'}` : 'No context used yet',
    },
    label ? h('span', { class: 'gauge-label' }, label) : null,
    h('span', { class: 'gauge-bar' }, h('span', { class: 'gauge-fill', style: `width:${pct.toFixed(1)}%` })),
    h('span', { class: 'gauge-text' }, g ? `${g.estimated ? '~' : ''}${fmtTokens(g.used)} / ${fmtTokens(g.window)} · ${pct.toFixed(1)}%` : '—'),
  );
}

// ---------------------------------------------------------------- auth screen

function renderAuth() {
  let mode: 'login' | 'register' = 'login';
  const error = h('div', { class: 'auth-error', role: 'alert' });
  const name = h('input', { name: 'name', placeholder: 'Your name', autocomplete: 'name' });
  const email = h('input', { name: 'email', type: 'email', placeholder: 'Email', required: true, autocomplete: 'email' });
  const password = h('input', { name: 'password', type: 'password', placeholder: 'Password (8+ characters)', required: true, autocomplete: 'current-password' });
  const submit = h('button', { type: 'submit', class: 'primary' }, 'Sign in');
  const nameRow = h('label', { class: 'field hidden' }, 'Name', name);
  const switchLink = h('button', { type: 'button', class: 'link' }, 'Create an account');

  const setMode = (m: typeof mode) => {
    mode = m;
    submit.textContent = m === 'login' ? 'Sign in' : 'Create account';
    switchLink.textContent = m === 'login' ? 'Create an account' : 'I already have an account';
    nameRow.classList.toggle('hidden', m === 'login');
    password.autocomplete = m === 'login' ? 'current-password' : 'new-password';
    error.textContent = '';
  };
  switchLink.addEventListener('click', () => setMode(mode === 'login' ? 'register' : 'login'));
  if (!state.allowRegistration) switchLink.classList.add('hidden');

  const form = h(
    'form',
    {
      class: 'auth-card',
      onsubmit: async (ev: Event) => {
        ev.preventDefault();
        submit.disabled = true;
        error.textContent = '';
        try {
          const body = { email: email.value, password: password.value, ...(mode === 'register' ? { name: name.value } : {}) };
          await api('POST', `/auth/${mode}`, body);
          state.addingAccount = false;
          await boot();
        } catch (err) {
          error.textContent = (err as Error).message;
        } finally {
          submit.disabled = false;
        }
      },
    },
    h('h1', null, 'CV Writer'),
    h('p', { class: 'muted' }, state.addingAccount ? 'Sign in to another account' : 'From first conversation to a polished, tailored CV.'),
    nameRow,
    h('label', { class: 'field' }, 'Email', email),
    h('label', { class: 'field' }, 'Password', password),
    error,
    submit,
    switchLink,
    state.addingAccount && state.user
      ? h('button', { type: 'button', class: 'link', onclick: () => ((state.addingAccount = false), renderShell(), loadWorkspace()) }, 'Cancel')
      : null,
  );
  replace(root, h('div', { class: 'auth-screen' }, form));
  email.focus();
}

// ---------------------------------------------------------------- shell

function renderShell() {
  els.sessions = h('nav', { class: 'list sessions', 'aria-label': 'Chat sessions' });
  els.jobs = h('nav', { class: 'list jobs', 'aria-label': 'Jobs' });
  els.account = h('div', { class: 'account' });
  els.title = h('h1', { class: 'chat-title' }, 'Chat');
  els.ctx = h('div', { class: 'chat-ctx' });
  els.messages = h('div', { class: 'messages', 'aria-live': 'polite' });
  els.input = h('textarea', {
    class: 'composer-input',
    rows: 2,
    placeholder: 'Message the coordinator…  (Enter to send, Shift+Enter for a new line)',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void submitMessage();
      }
    },
  });
  els.send = h('button', { type: 'submit', class: 'primary' }, 'Send');
  els.stop = h('button', { type: 'button', class: 'danger hidden', onclick: () => void stopRun() }, 'Stop');
  els.tabs = h('div', { class: 'tabs', role: 'tablist' });
  els.body = h('div', { class: 'inspector-body' });
  els.toasts = h('div', { class: 'toasts' });

  replace(
    root,
    h(
      'div',
      { class: 'shell' },
      h(
        'aside',
        { class: 'sidebar' },
        h('div', { class: 'brand' }, h('span', { class: 'logo' }, 'CV'), ' Writer'),
        els.account,
        h('div', { class: 'section-head' }, h('span', null, 'Chats'), h('button', { class: 'icon', title: 'New chat', onclick: () => void newSession() }, '+')),
        els.sessions,
        h('div', { class: 'section-head' }, h('span', null, 'Jobs'), h('button', { class: 'icon', title: 'New job', onclick: () => void newJob() }, '+')),
        els.jobs,
      ),
      h(
        'main',
        { class: 'chat' },
        h('header', { class: 'chat-header' }, els.title, els.ctx),
        els.messages,
        h(
          'form',
          {
            class: 'composer',
            onsubmit: (e: Event) => {
              e.preventDefault();
              void submitMessage();
            },
          },
          els.input,
          h('div', { class: 'composer-actions' }, els.stop, els.send),
        ),
      ),
      h('section', { class: 'inspector' }, els.tabs, els.body),
      els.toasts,
    ),
  );
  renderAccount();
  renderTabs();
}

function renderAccount() {
  const u = state.user!;
  const others = state.accounts.filter((a) => a.id !== u.id);
  replace(
    els.account,
    h(
      'details',
      { class: 'account-menu' },
      h('summary', null, h('span', { class: 'avatar' }, (u.name || u.email)[0]!.toUpperCase()), h('span', { class: 'account-name' }, u.name || u.email)),
      h(
        'div',
        { class: 'account-pop' },
        h('div', { class: 'muted small' }, u.email),
        others.length ? h('div', { class: 'small strong' }, 'Switch account') : null,
        others.map((a) =>
          h('button', { class: 'menu-item', onclick: () => void switchAccount(a.id) }, `${a.name || a.email}`, h('span', { class: 'muted small' }, ` ${a.email}`)),
        ),
        h('button', { class: 'menu-item', onclick: () => ((state.addingAccount = true), renderAuth()) }, '+ Add another account'),
        h('button', { class: 'menu-item', onclick: () => void logout(false) }, 'Sign out'),
        others.length ? h('button', { class: 'menu-item', onclick: () => void logout(true) }, 'Sign out of all accounts') : null,
      ),
    ),
  );
}

async function switchAccount(userId: string) {
  await guard(() => api('POST', '/auth/switch', { userId }));
  resetWorkspace();
  await boot();
}

async function logout(all: boolean) {
  await guard(() => api('POST', '/auth/logout', { all }));
  resetWorkspace();
  await boot();
}

function resetWorkspace() {
  Object.assign(state, { sessions: [], sessionId: null, session: null, liveEvents: [], jobs: [], jobId: null, jobDetail: null, profile: {}, draft: '' });
  state.dirty.clear();
  state.editorText = {};
}

// ---------------------------------------------------------------- data loading

async function boot() {
  const me = await api('GET', '/auth/me').catch(() => ({ user: null, accounts: [] }));
  state.user = me.user;
  state.accounts = me.accounts ?? [];
  state.allowRegistration = me.allowRegistration ?? true;
  if (!state.user) return renderAuth();
  renderShell();
  await loadWorkspace();
}

async function loadWorkspace() {
  await guard(async () => {
    const [sessions, jobs, profile, system] = await Promise.all([
      api('GET', '/sessions'),
      api('GET', '/jobs'),
      api('GET', '/profile'),
      api('GET', '/system'),
    ]);
    state.sessions = sessions.sessions;
    state.jobs = jobs.jobs;
    state.profile = profile.profile;
    state.agents = system.agents;
    if (!state.sessions.length) state.sessions = [(await api('POST', '/sessions', {})).session];
    renderSessions();
    renderJobs();
    await selectSession(state.sessionId && state.sessions.some((s) => s.id === state.sessionId) ? state.sessionId : state.sessions[0].id);
    if (state.jobs.length) await selectJob(state.jobId ?? state.jobs[0].id, false);
    else renderInspector();
  });
}

async function refreshSessions() {
  const data = await guard(() => api('GET', '/sessions'));
  if (data) state.sessions = data.sessions;
  renderSessions();
}

async function selectSession(id: string) {
  const data = await guard(() => api('GET', `/sessions/${id}`));
  if (!data) return;
  state.sessionId = id;
  state.session = data.session;
  state.liveEvents = [];
  state.draft = '';
  renderSessions();
  renderMessages();
  renderHeader();
  if (state.tab === 'activity') renderInspector();
  if (data.session.busy && !state.streaming) void follow(attachStream(id));
}

async function refreshJobs() {
  const data = await guard(() => api('GET', '/jobs'));
  if (data) state.jobs = data.jobs;
  renderJobs();
}

async function selectJob(id: string, switchTab = true) {
  const data = await guard(() => api('GET', `/jobs/${id}`));
  if (!data) return;
  if (state.jobId !== id) {
    (['job', 'cv', 'css', 'preferences'] as Tab[]).forEach((t) => state.dirty.delete(t));
  }
  state.jobId = id;
  state.jobDetail = data;
  renderJobs();
  if (switchTab && !['job', 'cv', 'css', 'preferences'].includes(state.tab)) state.tab = 'cv';
  renderTabs();
  renderInspector();
}

const refreshTimers = new Map<string, number>();
function refreshEntity(entity: DataEntity, jobId?: string) {
  const key = `${entity}:${jobId ?? ''}`;
  clearTimeout(refreshTimers.get(key));
  refreshTimers.set(
    key,
    window.setTimeout(async () => {
      if (entity === 'profile') {
        const data = await guard(() => api('GET', '/profile'));
        if (data) state.profile = data.profile;
        markUpdated('profile');
      } else {
        if (entity === 'job') await refreshJobs();
        if (jobId && (!state.jobId || !state.jobs.some((j) => j.id === state.jobId))) state.jobId = jobId;
        if (jobId && jobId === state.jobId) {
          const data = await guard(() => api('GET', `/jobs/${jobId}`));
          if (data) state.jobDetail = data;
          markUpdated(entity === 'cv' ? 'cv' : entity === 'css' ? 'css' : entity === 'preferences' ? 'preferences' : 'job');
          if (entity !== 'job') void refreshJobs();
        }
      }
      if (state.tab !== 'activity') renderInspector();
    }, 250),
  );
}

function markUpdated(tab: Tab) {
  if (state.tab !== tab) state.updatedTabs.add(tab);
  renderTabs();
}

// ---------------------------------------------------------------- sidebar

function renderSessions() {
  replace(
    els.sessions,
    state.sessions.map((s) =>
      h(
        'div',
        { class: `list-item ${s.id === state.sessionId ? 'active' : ''}` },
        h(
          'button',
          { class: 'list-main', onclick: () => s.id !== state.sessionId && void selectSession(s.id), title: s.title },
          h('span', { class: 'list-title' }, s.title),
          h('span', { class: 'list-sub' }, relativeTime(s.updatedAt)),
        ),
        h(
          'button',
          {
            class: `icon del ${state.confirmDelete === s.id ? 'confirm' : ''}`,
            title: 'Delete chat',
            onclick: () => void deleteSession(s.id),
          },
          state.confirmDelete === s.id ? 'Delete?' : '×',
        ),
      ),
    ),
  );
}

function renderJobs() {
  replace(
    els.jobs,
    state.jobs.length
      ? state.jobs.map((j) =>
          h(
            'div',
            { class: `list-item ${j.id === state.jobId ? 'active' : ''}` },
            h(
              'button',
              { class: 'list-main', onclick: () => void selectJob(j.id) },
              h('span', { class: 'list-title' }, j.title),
              h('span', { class: 'list-sub' }, [j.company, j.cvChars ? 'CV drafted' : 'no CV yet'].filter(Boolean).join(' · ')),
            ),
          ),
        )
      : h('p', { class: 'muted small pad' }, 'No jobs yet. Tell the coordinator about a role you are targeting.'),
  );
}

async function newSession() {
  const data = await guard(() => api('POST', '/sessions', {}));
  if (!data) return;
  state.sessions.unshift(data.session);
  await selectSession(data.session.id);
  els.input.focus();
}

async function deleteSession(id: string) {
  if (state.confirmDelete !== id) {
    state.confirmDelete = id;
    renderSessions();
    setTimeout(() => {
      if (state.confirmDelete === id) {
        state.confirmDelete = null;
        renderSessions();
      }
    }, 3000);
    return;
  }
  state.confirmDelete = null;
  await guard(() => api('DELETE', `/sessions/${id}`));
  state.sessions = state.sessions.filter((s) => s.id !== id);
  if (!state.sessions.length) state.sessions = [(await api('POST', '/sessions', {})).session];
  if (state.sessionId === id) await selectSession(state.sessions[0].id);
  else renderSessions();
}

async function newJob() {
  const data = await guard(() => api('POST', '/jobs', { job: { title: 'New job', company: '' } }));
  if (!data) return;
  await refreshJobs();
  state.tab = 'job';
  await selectJob(data.job.id);
}

// ---------------------------------------------------------------- chat

function renderHeader() {
  els.title.textContent = state.session?.title ?? 'Chat';
  const coordinator = state.agents.find((a) => a.name === 'coordinator');
  replace(
    els.ctx,
    gauge(
      latestCoordinatorContext(allEvents()) ?? (coordinator ? { used: 0, window: coordinator.contextWindow, estimated: true } : undefined),
      'Coordinator context',
    ),
  );
  els.send.disabled = state.streaming;
  els.stop.classList.toggle('hidden', !state.streaming);
}

function statusLine(): string {
  const running: { agent: string; tool?: string }[] = [];
  const open = new Map<string, { agent: string; tool?: string }>();
  for (const e of state.liveEvents) {
    if (e.type === 'run_start') open.set(e.runId, { agent: e.agent });
    else if (e.type === 'run_end') open.delete(e.runId);
    else if (e.type === 'tool_start' && open.has(e.runId)) open.get(e.runId)!.tool = e.name;
    else if (e.type === 'tool_end' && open.has(e.runId)) open.get(e.runId)!.tool = undefined;
  }
  running.push(...open.values());
  const deepest = running.at(-1);
  if (!deepest) return 'Working…';
  const who = deepest.agent[0].toUpperCase() + deepest.agent.slice(1);
  return deepest.tool ? `${who} is running ${deepest.tool}…` : `${who} is thinking…`;
}

function renderMessages() {
  const nearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
  const messages = state.session?.messages ?? [];
  const nodes: Node[] = messages.map((m) =>
    h(
      'div',
      { class: `msg ${m.role}` },
      m.role === 'assistant' ? h('div', { class: 'bubble md', html: renderMarkdown(m.content) }) : h('div', { class: 'bubble' }, m.content),
    ),
  );
  if (state.streaming) {
    if (state.draft) nodes.push(h('div', { class: 'msg assistant' }, h('div', { class: 'bubble md', html: renderMarkdown(state.draft) })));
    nodes.push(h('div', { class: 'status-line' }, h('span', { class: 'spinner' }), statusLine()));
  }
  if (!messages.length && !state.streaming) {
    nodes.push(
      h(
        'div',
        { class: 'welcome' },
        h('h2', null, 'Hi! I’m your CV coordinator.'),
        h('p', null, 'I’ll interview you, capture the jobs you’re targeting, and work with a writer and a critic to produce tailored CVs you can download as PDF.'),
        h(
          'div',
          { class: 'suggestions' },
          [
            'Help me write a CV from scratch',
            'Here is a job advert I want to apply for: ',
            'Review my existing CV for a new role',
          ].map((s) => h('button', { class: 'chip', onclick: () => ((els.input.value = s), els.input.focus()) }, s)),
        ),
      ),
    );
  }
  replace(els.messages, nodes);
  if (nearBottom || state.streaming) els.messages.scrollTop = els.messages.scrollHeight;
}

async function submitMessage() {
  const content = els.input.value.trim();
  if (!content || state.streaming || !state.sessionId) return;
  els.input.value = '';
  await follow(sendMessage(state.sessionId, content));
}

/** Consumes a run's event stream (new message or re-attach after reload). */
async function follow(request: Promise<Response>) {
  const sessionId = state.sessionId!;
  state.streaming = true;
  state.liveEvents = [];
  state.draft = '';
  state.liveText.clear();
  renderHeader();
  renderMessages();
  try {
    await readEventStream(await request, (e) => sessionId === state.sessionId && onEvent(e));
  } catch (err) {
    toast((err as Error).message, 'error');
  } finally {
    state.streaming = false;
    state.liveText.clear();
    if (sessionId === state.sessionId) {
      await selectSession(sessionId);
      await refreshSessions();
    }
    renderHeader();
  }
}

function onEvent(e: AgentEvent) {
  switch (e.type) {
    case 'text_delta': {
      if (state.runAgents.get(e.runId) === 'coordinator') {
        state.draft += e.delta;
        schedule('messages');
      } else {
        state.liveText.set(e.runId, (state.liveText.get(e.runId) ?? '') + e.delta);
        schedule('inspector');
      }
      return;
    }
    case 'thinking_delta':
      return;
    case 'user_message':
      state.session?.messages.push({ role: 'user', content: e.content, at: e.at });
      break;
    case 'run_start':
      state.runAgents.set(e.runId, e.agent);
      break;
    case 'llm_end':
      if (state.runAgents.get(e.runId) === 'coordinator') {
        if (e.content.trim()) state.session?.messages.push({ role: 'assistant', content: e.content, at: e.at });
        state.draft = '';
      } else state.liveText.delete(e.runId);
      break;
    case 'data_changed':
      refreshEntity(e.entity, e.jobId);
      break;
    case 'error':
      toast(e.message, 'error');
      break;
    default:
      break;
  }
  if (e.type !== 'llm_start') state.liveEvents.push(e);
  schedule('messages', 'header', 'inspector');
}

async function stopRun() {
  if (!state.sessionId) return;
  await guard(() => api('POST', `/sessions/${state.sessionId}/stop`, {}));
}

// ---------------------------------------------------------------- inspector

function renderTabs() {
  replace(
    els.tabs,
    TABS.map((t) =>
      h(
        'button',
        {
          class: `tab ${state.tab === t.id ? 'active' : ''}`,
          role: 'tab',
          'aria-selected': String(state.tab === t.id),
          onclick: () => {
            state.tab = t.id;
            state.updatedTabs.delete(t.id);
            renderTabs();
            renderInspector();
          },
        },
        t.label,
        state.updatedTabs.has(t.id) ? h('span', { class: 'dot', title: 'Updated' }) : null,
      ),
    ),
  );
}

function renderInspector() {
  if (!els.body) return;
  const keepScroll = els.body.scrollTop;
  const stick = els.body.scrollHeight - els.body.scrollTop - els.body.clientHeight < 80;
  let content: Node;
  switch (state.tab) {
    case 'activity':
      content = renderActivity();
      break;
    case 'profile':
      content = h(
        'div',
        { class: 'pane' },
        h('p', { class: 'muted small' }, 'Your career profile (JSON). The coordinator fills it in as you chat; you can edit it directly too.'),
        editor('profile', JSON.stringify(state.profile, null, 2), async (text) => {
          const profile = parseJson(text);
          const data = await api('PUT', '/profile', { profile });
          state.profile = data.profile;
        }),
      );
      break;
    default:
      content = renderJobPane(state.tab);
  }
  replace(els.body, content);
  els.body.scrollTop = state.tab === 'activity' && stick ? els.body.scrollHeight : keepScroll;
}

function parseJson(text: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`Invalid JSON: ${(err as Error).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The document must be a JSON object');
  return value as Record<string, unknown>;
}

function editor(tab: Tab, serverValue: string, save: (text: string) => Promise<void>, opts: { language?: string } = {}) {
  const dirty = state.dirty.has(tab);
  const status = h('span', { class: 'muted small' }, dirty ? 'Unsaved changes' : '');
  const area = h('textarea', {
    class: `editor ${opts.language ?? ''}`,
    spellcheck: false,
    value: dirty ? (state.editorText[tab] ?? serverValue) : serverValue,
    oninput: () => {
      state.dirty.add(tab);
      state.editorText[tab] = area.value;
      status.textContent = 'Unsaved changes';
    },
    onkeydown: (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveBtn.click();
      }
    },
  });
  const saveBtn = h(
    'button',
    {
      class: 'primary',
      onclick: async () => {
        try {
          await save(area.value);
          state.dirty.delete(tab);
          delete state.editorText[tab];
          toast('Saved');
          renderInspector();
          void refreshJobs();
        } catch (err) {
          toast((err as Error).message, 'error');
        }
      },
    },
    'Save',
  );
  const revert = h(
    'button',
    {
      onclick: () => {
        state.dirty.delete(tab);
        delete state.editorText[tab];
        renderInspector();
      },
    },
    'Revert',
  );
  return h('div', { class: 'editor-wrap' }, area, h('div', { class: 'editor-actions' }, status, revert, saveBtn));
}

function renderJobPane(tab: Tab): Node {
  if (!state.jobs.length || !state.jobDetail) {
    return h(
      'div',
      { class: 'pane empty' },
      h('p', null, 'No job selected.'),
      h('p', { class: 'muted small' }, 'Paste a job advert in the chat and the coordinator will create the job, its CV, preferences and stylesheet.'),
      h('button', { onclick: () => void newJob() }, 'Create an empty job'),
    );
  }
  const { job, cv } = state.jobDetail;
  const picker = h(
    'select',
    { class: 'job-picker', 'aria-label': 'Job', onchange: (e: Event) => void selectJob((e.target as HTMLSelectElement).value, false) },
    state.jobs.map((j) => h('option', { value: j.id, selected: j.id === state.jobId }, `${j.title}${j.company ? ` — ${j.company}` : ''}`)),
  );
  const bar = h('div', { class: 'job-bar' }, picker);

  let body: Node;
  if (tab === 'job') {
    const del = h(
      'button',
      {
        class: `danger ${state.confirmDelete === job.id ? 'confirm' : ''}`,
        onclick: async () => {
          if (state.confirmDelete !== job.id) {
            state.confirmDelete = job.id;
            renderInspector();
            return;
          }
          state.confirmDelete = null;
          await guard(() => api('DELETE', `/jobs/${job.id}`));
          state.jobId = null;
          state.jobDetail = null;
          await refreshJobs();
          if (state.jobs.length) await selectJob(state.jobs[0].id, false);
          else renderInspector();
        },
      },
      state.confirmDelete === job.id ? 'Really delete job + CV?' : 'Delete job',
    );
    body = h(
      'div',
      { class: 'pane' },
      h('div', { class: 'pane-head' }, h('p', { class: 'muted small' }, 'Target job (JSON). Each job has exactly one CV.'), del),
      editor('job', JSON.stringify(job.data, null, 2), async (text) => {
        await api('PUT', `/jobs/${job.id}`, { job: parseJson(text) });
        await selectJob(job.id, false);
      }),
    );
  } else if (tab === 'cv') {
    const frame = h('iframe', { class: 'cv-frame', sandbox: '', title: 'CV preview' });
    frame.srcdoc = buildCvDocument(cv.html, cv.css, {
      title: String(job.data.title ?? 'CV'),
      lang: typeof cv.preferences.language === 'string' ? cv.preferences.language : undefined,
    });
    const openKey = 'cv-source';
    body = h(
      'div',
      { class: 'pane cv-pane' },
      h(
        'div',
        { class: 'cv-toolbar' },
        h('a', { class: 'button primary', href: `/api/jobs/${job.id}/cv.pdf`, download: '' }, 'Download PDF'),
        h('a', { class: 'button', href: `/api/jobs/${job.id}/cv.pdf?inline=1`, target: '_blank', rel: 'noopener' }, 'Open PDF'),
        h('a', { class: 'button', href: `/api/jobs/${job.id}/cv.html`, target: '_blank', rel: 'noopener' }, 'Printable page'),
        h('span', { class: 'muted small' }, cv.html.trim() ? `Updated ${relativeTime(cv.updatedAt)}` : 'Not written yet'),
      ),
      h('div', { class: 'cv-frame-wrap' }, frame),
      details(openKey, h('summary', null, 'HTML source'), () =>
        editor('cv', cv.html, async (text) => {
          await api('PUT', `/jobs/${job.id}/cv`, { html: text });
          await selectJob(job.id, false);
        }),
      ),
    );
  } else if (tab === 'css') {
    body = h(
      'div',
      { class: 'pane' },
      h('p', { class: 'muted small' }, 'Raw CSS applied to this CV in the preview and the PDF. The writer edits it; you can too.'),
      editor(
        'css',
        cv.css,
        async (text) => {
          await api('PUT', `/jobs/${job.id}/css`, { css: text });
          await selectJob(job.id, false);
        },
        { language: 'code' },
      ),
    );
  } else {
    body = h(
      'div',
      { class: 'pane' },
      h('p', { class: 'muted small' }, 'Preferences for this CV (JSON): language, paperSize (A4/Letter), maxPages, tone, sectionOrder, emphasise, exclude, notes…'),
      editor('preferences', JSON.stringify(cv.preferences, null, 2), async (text) => {
        await api('PUT', `/jobs/${job.id}/preferences`, { preferences: parseJson(text) });
        await selectJob(job.id, false);
      }),
    );
  }
  return h('div', { class: 'job-pane' }, bar, body);
}

/** <details> whose open state survives re-renders; content is built lazily. */
function details(key: string, summary: HTMLElement, build: () => Node, cls = '') {
  const el = h('details', { class: cls });
  el.open = state.openDetails.has(key);
  el.appendChild(summary);
  let built = false;
  const ensure = () => {
    if (!built && el.open) {
      el.appendChild(build());
      built = true;
    }
  };
  ensure();
  el.addEventListener('toggle', () => {
    if (el.open) state.openDetails.add(key);
    else state.openDetails.delete(key);
    ensure();
  });
  return el;
}

// ---------------------------------------------------------------- activity

function renderActivity(): Node {
  const events = allEvents();
  const turns = buildTurns(events);
  const sum = totals(events);
  const agents = state.agents.map((a) =>
    h(
      'div',
      { class: 'agent-info' },
      h('span', { class: `agent-badge ${a.name}` }, a.name),
      h('span', { class: 'muted small' }, `${a.model} · ${fmtTokens(a.contextWindow)} ctx · ${a.tools.length} tools · skills: ${a.skills.map((s) => s.name).join(', ') || 'none'}`),
    ),
  );
  return h(
    'div',
    { class: 'activity' },
    h(
      'div',
      { class: 'activity-summary' },
      h('div', { class: 'stats' }, `${sum.runs} agent runs · ${sum.tools} tool calls · ${fmtTokens(sum.promptTokens)} prompt + ${fmtTokens(sum.completionTokens)} completion tokens processed`),
      details('agents-info', h('summary', { class: 'small' }, 'Agents, models & skills'), () => h('div', null, agents)),
    ),
    turns.length
      ? turns.map((t, i) =>
          h(
            'div',
            { class: 'turn' },
            t.userMessage ? h('div', { class: 'turn-head' }, h('span', { class: 'muted small' }, `Turn ${i + 1}`), h('span', { class: 'turn-msg' }, t.userMessage)) : null,
            t.runs.map(runCard),
            t.notes.length ? h('div', { class: 'notes' }, t.notes.map((n) => h('span', { class: `note ${n.level}` }, n.text))) : null,
          ),
        )
      : h('p', { class: 'muted pad' }, 'Agent activity — every model call, tool call, subagent run and the context each agent used — appears here as you chat.'),
  );
}

function runCard(run: RunNode): HTMLElement {
  const tokens = run.promptTokens !== undefined ? `${fmtTokens(run.promptTokens)}↑ ${fmtTokens(run.completionTokens ?? 0)}↓ tok` : '';
  const meta = [run.steps ? `${run.steps} step${run.steps > 1 ? 's' : ''}` : '', fmtDuration(run.durationMs), tokens].filter(Boolean).join(' · ');
  const live = state.liveText.get(run.runId);
  return h(
    'div',
    { class: `run run-${run.status}`, dataset: { agent: run.agent } },
    h(
      'div',
      { class: 'run-head' },
      h('span', { class: `agent-badge ${run.agent}` }, run.agent),
      h('span', { class: `status ${run.status}` }, run.status === 'running' ? h('span', { class: 'spinner' }) : run.status === 'ok' ? '✓' : '✗'),
      h('span', { class: 'muted small run-model' }, run.model),
      h('span', { class: 'muted small run-meta' }, meta),
    ),
    gauge(run.context, run.status === 'running' ? 'context' : 'context (last)'),
    run.parentRunId ? h('div', { class: 'run-task' }, h('span', { class: 'muted small' }, 'Task: '), run.task) : null,
    h('div', { class: 'run-items' }, run.items.map((item, i) => itemView(run, item, i))),
    live ? h('div', { class: 'live-text' }, live.slice(-600)) : null,
    run.parentRunId && run.result
      ? details(`${run.runId}:result`, h('summary', { class: 'small' }, run.status === 'ok' ? 'Report to caller' : 'Failure'), () => h('div', { class: 'md small', html: renderMarkdown(run.result!) }))
      : null,
  );
}

function briefArgs(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const parts = Object.entries(args as Record<string, unknown>).map(([k, v]) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return `${k}: ${s.length > 40 ? `${s.slice(0, 40)}…` : s}`;
  });
  const out = parts.join(', ');
  return out.length > 90 ? `${out.slice(0, 90)}…` : out;
}

function itemView(run: RunNode, item: RunItem, index: number): Node {
  if (item.kind === 'note') return h('div', { class: `note ${item.level}` }, item.text);
  if (item.kind === 'llm') {
    const tokens = item.promptTokens !== undefined ? ` · ${fmtTokens(item.promptTokens)}↑ ${fmtTokens(item.completionTokens ?? 0)}↓` : '';
    return h(
      'div',
      { class: 'llm-step' },
      item.thinking
        ? details(`${run.runId}:${index}:think`, h('summary', { class: 'small muted' }, `Reasoning · step ${item.step + 1} · ${fmtDuration(item.durationMs)}${tokens}`), () =>
            h('pre', { class: 'thinking' }, item.thinking!),
          )
        : h('div', { class: 'small muted' }, `Model reply · step ${item.step + 1} · ${fmtDuration(item.durationMs)}${tokens}`),
      item.content.trim() && (run.agent !== 'coordinator' || item.toolCalls > 0)
        ? h('div', { class: 'llm-text md small', html: renderMarkdown(item.content.length > 1500 ? `${item.content.slice(0, 1500)}…` : item.content) })
        : null,
    );
  }
  const status = item.ok === undefined ? h('span', { class: 'spinner' }) : item.ok ? h('span', { class: 'ok' }, '✓') : h('span', { class: 'err' }, '✗');
  return h(
    'div',
    { class: 'tool' },
    details(
      `${run.runId}:${item.callId}`,
      h(
        'summary',
        null,
        status,
        h('span', { class: 'tool-name' }, item.name),
        h('span', { class: 'tool-args muted' }, briefArgs(item.args)),
        h('span', { class: 'muted small' }, fmtDuration(item.durationMs)),
      ),
      () =>
        h(
          'div',
          { class: 'tool-body' },
          h('div', { class: 'small strong' }, 'Arguments'),
          h('pre', null, JSON.stringify(item.args, null, 2)),
          item.result !== undefined ? h('div', { class: 'small strong' }, 'Result') : null,
          item.result !== undefined ? h('pre', { class: item.ok ? '' : 'err' }, prettyJson(item.result)) : null,
        ),
    ),
    item.children.length ? h('div', { class: 'subruns' }, item.children.map(runCard)) : null,
  );
}

// ---------------------------------------------------------------- start

void boot();
