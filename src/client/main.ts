import { applyEvent, emptyActivity, type Activity } from '../shared/activity.js';
import type { AgentEvent, ContextInfo, DataEntity } from '../shared/events.js';
import { renderMarkdown } from '../shared/markdown.js';
import { activitySummary, contextMeter, contextTable, liveAnswer, OpenState, renderActivity } from './activity-view.js';
import { api, ApiError, streamEvents } from './api.js';
import { clear, fmtNum, h, toast } from './dom.js';

// ---------------------------------------------------------------- types & state

interface UserInfo {
  id: string;
  email: string;
  name: string;
}
interface ChatSummary {
  id: string;
  title: string;
  updatedAt: string;
}
interface JobSummary {
  id: string;
  title: string;
  company: string;
  status: string;
  hasCv: boolean;
}
interface Turn {
  id: string;
  user: string;
  answer: string;
  status: 'done' | 'error' | 'aborted';
  error?: string;
  activity: Activity;
  startedAt: string;
  endedAt: string;
}
type Tab = 'cv' | 'css' | 'profile' | 'job' | 'prefs' | 'activity' | 'skills';

const state = {
  user: null as UserInfo | null,
  accounts: [] as UserInfo[],
  addingAccount: false,
  system: null as null | { models: Record<string, string>; contextWindows: Record<string, number> },
  chats: [] as ChatSummary[],
  chatId: null as string | null,
  turns: [] as Turn[],
  live: null as null | { userText: string; activity: Activity; answer?: string; done?: boolean },
  transcriptTokens: 0,
  jobs: [] as JobSummary[],
  focusJobId: null as string | null,
  tab: 'cv' as Tab,
  dirty: new Set<string>(),
  stale: new Set<string>(),
  stream: null as AbortController | null,
  confirmDelete: null as string | null,
};
const openState = new OpenState();
const $app = document.getElementById('app')!;

const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(`cvw:${state.user?.id}:${key}`);
    } catch {
      return null;
    }
  },
  set(key: string, value: string | null) {
    try {
      if (value === null) localStorage.removeItem(`cvw:${state.user?.id}:${key}`);
      else localStorage.setItem(`cvw:${state.user?.id}:${key}`, value);
    } catch {
      /* storage unavailable */
    }
  },
};

const focusJob = () => state.jobs.find((j) => j.id === state.focusJobId) ?? null;
const jobLabel = (j: JobSummary) => `${j.title || 'Untitled job'}${j.company ? ` · ${j.company}` : ''}`;

// ---------------------------------------------------------------- boot & auth

async function boot() {
  try {
    const me = await api<{ user: UserInfo | null; accounts: UserInfo[] }>('GET', '/api/auth/me');
    state.user = me.user;
    state.accounts = me.accounts;
  } catch {
    state.user = null;
  }
  if (!state.user) return renderAuth();
  await enterApp();
}

async function enterApp() {
  state.addingAccount = false;
  state.chatId = null;
  state.turns = [];
  state.live = null;
  state.dirty.clear();
  state.focusJobId = store.get('focusJob');
  state.tab = (store.get('tab') as Tab) || 'cv';
  renderShell();
  const [system, chats, jobs] = await Promise.all([
    api('GET', '/api/system').catch(() => null),
    api<{ chats: ChatSummary[] }>('GET', '/api/chats'),
    api<{ jobs: JobSummary[] }>('GET', '/api/jobs'),
  ]);
  state.system = system;
  state.chats = chats.chats;
  state.jobs = jobs.jobs;
  if (state.focusJobId && !focusJob()) state.focusJobId = null;
  renderTopbar();
  renderSidebar();
  renderWorkspace();
  const last = store.get('chat');
  const initial = state.chats.find((c) => c.id === last) ?? state.chats[0];
  if (initial) await openChat(initial.id);
  else renderThread();
}

function renderAuth() {
  let mode: 'login' | 'register' = 'login';
  const card = h('div.auth-card');
  const draw = (error = '') => {
    const form = h(
      'form.auth-form',
      {
        onsubmit: async (ev: Event) => {
          ev.preventDefault();
          const fd = new FormData(ev.target as HTMLFormElement);
          const payload = Object.fromEntries(fd.entries());
          const btn = form.querySelector('button[type=submit]') as HTMLButtonElement;
          btn.disabled = true;
          try {
            const res = await api<{ user: UserInfo; accounts: UserInfo[] }>('POST', `/api/auth/${mode}`, payload);
            state.user = res.user;
            state.accounts = res.accounts;
            await enterApp();
          } catch (err) {
            draw((err as Error).message);
          }
        },
      },
      mode === 'register' ? h('label', 'Name', h('input', { name: 'name', required: true, autocomplete: 'name', maxlength: 100 })) : null,
      h('label', 'Email', h('input', { name: 'email', type: 'email', required: true, autocomplete: 'email' })),
      h(
        'label',
        'Password',
        h('input', {
          name: 'password',
          type: 'password',
          required: true,
          minlength: 8,
          autocomplete: mode === 'login' ? 'current-password' : 'new-password',
        }),
      ),
      error ? h('div.form-error', error) : null,
      h('button.primary', { type: 'submit' }, mode === 'login' ? 'Sign in' : 'Create account'),
    );
    clear(
      card,
      h('div.brand.big', h('span.logo', 'CV'), ' Writer'),
      h('p.muted', state.addingAccount ? 'Add another account — you can switch between them any time.' : 'One assistant, from first chat to finished PDF.'),
      h(
        'div.auth-tabs',
        h('button', { class: mode === 'login' ? 'active' : '', onclick: () => ((mode = 'login'), draw()) }, 'Sign in'),
        h('button', { class: mode === 'register' ? 'active' : '', onclick: () => ((mode = 'register'), draw()) }, 'Create account'),
      ),
      form,
      state.addingAccount && state.user
        ? h('button.link', { onclick: () => enterApp() }, `Cancel — back to ${state.user.name || state.user.email}`)
        : null,
    );
    (form.querySelector('input') as HTMLInputElement | null)?.focus();
  };
  draw();
  clear($app, h('div.auth-screen', card), h('div#toasts'));
}

async function switchAccount(userId: string) {
  state.stream?.abort();
  const res = await api<{ user: UserInfo; accounts: UserInfo[] }>('POST', '/api/auth/switch', { userId });
  state.user = res.user;
  state.accounts = res.accounts;
  await enterApp();
  toast(`Switched to ${res.user.name || res.user.email}`);
}

async function logout(all = false) {
  state.stream?.abort();
  const res = await api<{ user: UserInfo | null; accounts: UserInfo[] }>('POST', '/api/auth/logout', { all });
  state.user = res.user;
  state.accounts = res.accounts;
  if (state.user) await enterApp();
  else renderAuth();
}

// ---------------------------------------------------------------- shell

const els = {} as {
  topbar: HTMLElement;
  sidebar: HTMLElement;
  thread: HTMLElement;
  composer: HTMLElement;
  workspace: HTMLElement;
  liveBlock?: HTMLElement;
};

function renderShell() {
  els.topbar = h('header.topbar');
  els.sidebar = h('aside.sidebar');
  els.thread = h('div.thread');
  els.composer = h('div.composer');
  els.workspace = h('section.workspace');
  clear(
    $app,
    els.topbar,
    h('div.layout', els.sidebar, h('main.chat', els.thread, els.composer), els.workspace),
    h('div#toasts'),
  );
  renderTopbar();
  renderComposer();
}

function initials(u: UserInfo) {
  return (u.name || u.email)
    .split(/\s+/)
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
}

function coordinatorContext(): ContextInfo | undefined {
  const fromActivity = (a: Activity | undefined) => (a ? a.runs[a.rootRunIds[0]]?.context : undefined);
  if (state.live) return fromActivity(state.live.activity);
  for (let i = state.turns.length - 1; i >= 0; i--) {
    const c = fromActivity(state.turns[i].activity);
    if (c) return c;
  }
  return undefined;
}

function topCtx() {
  const ctx = coordinatorContext();
  return h(
    'div.top-ctx',
    { title: 'Coordinator context window usage (estimated)' },
    h('span.muted.small', 'Coordinator context'),
    ctx ? contextMeter(ctx) : h('span.muted.small', state.transcriptTokens ? `transcript ~${fmtNum(state.transcriptTokens)} tok` : '–'),
  );
}

function updateTopCtx() {
  els.topbar?.querySelector('.top-ctx')?.replaceWith(topCtx());
}

function renderTopbar() {
  if (!els.topbar || !state.user) return;
  const user = state.user;
  const menu = h(
    'div.menu',
    h('div.menu-label', 'Signed-in accounts'),
    state.accounts.map((a) =>
      h(
        'button.menu-item',
        { class: a.id === user.id ? 'active' : '', onclick: () => a.id !== user.id && switchAccount(a.id) },
        h('span.avatar.sm', initials(a)),
        h('span', h('div', a.name || a.email), h('div.muted.small', a.email)),
        a.id === user.id ? h('span.check', '✓') : null,
      ),
    ),
    h('hr'),
    h('button.menu-item', { onclick: () => ((state.addingAccount = true), renderAuth()) }, '＋ Add another account'),
    h('button.menu-item', { onclick: () => logout(false) }, `Sign out ${user.email}`),
    state.accounts.length > 1 ? h('button.menu-item', { onclick: () => logout(true) }, 'Sign out of all accounts') : null,
  );
  const account = h(
    'div.account',
    h(
      'button.account-btn',
      {
        onclick: (e: Event) => {
          e.stopPropagation();
          account.classList.toggle('open');
        },
      },
      h('span.avatar', initials(user)),
      h('span.account-name', user.name || user.email),
      state.accounts.length > 1 ? h('span.badge', String(state.accounts.length)) : null,
    ),
    menu,
  );
  const models = state.system?.models;
  clear(
    els.topbar,
    h('div.brand', h('span.logo', 'CV'), ' Writer'),
    topCtx(),
    models
      ? h(
          'div.models.small.muted',
          { title: 'Models per agent' },
          `coord: ${models.coordinator} · writer: ${models.writer} · critic: ${models.critic}`,
        )
      : null,
    account,
  );
}

// ---------------------------------------------------------------- sidebar: chats & jobs

function renderSidebar() {
  if (!els.sidebar) return;
  const chatItems = state.chats.map((c) => {
    const confirming = state.confirmDelete === `chat:${c.id}`;
    return h(
      'div.side-item',
      { class: c.id === state.chatId ? 'active' : '', onclick: () => openChat(c.id), title: c.title },
      h('span.side-title', c.title),
      h(
        'button.icon',
        {
          title: confirming ? 'Click again to delete' : 'Delete chat',
          class: confirming ? 'danger' : '',
          onclick: async (e: Event) => {
            e.stopPropagation();
            if (!confirming) {
              state.confirmDelete = `chat:${c.id}`;
              renderSidebar();
              return;
            }
            state.confirmDelete = null;
            await api('DELETE', `/api/chats/${c.id}`);
            state.chats = state.chats.filter((x) => x.id !== c.id);
            if (state.chatId === c.id) {
              state.chatId = null;
              state.turns = [];
              state.live = null;
              renderThread();
            }
            renderSidebar();
          },
        },
        confirming ? 'Delete?' : '×',
      ),
    );
  });
  const jobItems = state.jobs.map((j) =>
    h(
      'div.side-item',
      { class: j.id === state.focusJobId ? 'active' : '', onclick: () => setFocusJob(j.id, true), title: jobLabel(j) },
      h('span.side-title', jobLabel(j)),
      h('span.pill', { class: j.hasCv ? 'ok' : '' }, j.hasCv ? 'CV' : 'no CV'),
    ),
  );
  clear(
    els.sidebar,
    h('div.side-head', h('span', 'Chats'), h('button.small', { onclick: () => newChat() }, '＋ New')),
    h('div.side-list', chatItems.length ? chatItems : h('div.muted.small.pad', 'No chats yet')),
    h('div.side-head', h('span', 'Jobs'), h('button.small', { onclick: () => newJob() }, '＋ New')),
    h('div.side-list', jobItems.length ? jobItems : h('div.muted.small.pad', 'No jobs yet — paste a job ad in the chat')),
  );
}

async function newChat(): Promise<string> {
  state.stream?.abort();
  const { chat } = await api<{ chat: ChatSummary }>('POST', '/api/chats', {});
  state.chats.unshift(chat);
  state.chatId = chat.id;
  state.turns = [];
  state.live = null;
  state.transcriptTokens = 0;
  store.set('chat', chat.id);
  renderSidebar();
  renderThread();
  renderTopbar();
  return chat.id;
}

async function newJob() {
  const { job } = await api<{ job: { id: string } }>('POST', '/api/jobs', { job: { title: 'Untitled job' } });
  await reloadJobs();
  setFocusJob(job.id, false);
  setTab('job');
}

async function reloadJobs() {
  state.jobs = (await api<{ jobs: JobSummary[] }>('GET', '/api/jobs')).jobs;
  if (state.focusJobId && !focusJob()) setFocusJob(null, false);
  renderSidebar();
  renderComposer();
}

function setFocusJob(id: string | null, openCv: boolean) {
  state.focusJobId = id;
  store.set('focusJob', id);
  for (const k of ['job', 'prefs', 'css', 'cv']) state.dirty.delete(k);
  renderSidebar();
  renderComposer();
  if (openCv && !['cv', 'css', 'job', 'prefs'].includes(state.tab)) setTab('cv');
  else renderWorkspace();
}

// ---------------------------------------------------------------- chat thread

async function openChat(id: string) {
  state.stream?.abort();
  state.stream = null;
  const res = await api<{
    chat: { id: string; title: string; turns: Turn[]; focusJobId: string | null };
    live: null | { turnId: string; userText: string; activity: Activity };
    context: { transcriptTokens: number };
  }>('GET', `/api/chats/${id}`);
  state.chatId = id;
  state.turns = res.chat.turns;
  state.transcriptTokens = res.context.transcriptTokens;
  state.live = null;
  store.set('chat', id);
  renderSidebar();
  renderThread();
  renderTopbar();
  renderComposer();
  if (res.live) void attachLive(id, res.live.userText);
}

/** Re-attach to a turn that is still running on the server (e.g. after reload). */
async function attachLive(chatId: string, userText: string) {
  state.live = { userText, activity: emptyActivity() };
  renderThread();
  renderComposer();
  const ctrl = new AbortController();
  state.stream = ctrl;
  try {
    await streamEvents(`/api/chats/${chatId}/stream`, { method: 'GET', signal: ctrl.signal }, onEvent);
  } catch (err) {
    if (!ctrl.signal.aborted && !(err instanceof ApiError && err.status === 404)) toast((err as Error).message, 'error');
  }
  if (!ctrl.signal.aborted && state.chatId === chatId) await finishLive(chatId);
}

async function send(text: string) {
  if (state.live) return;
  const chatId = state.chatId ?? (await newChat());
  state.live = { userText: text, activity: emptyActivity() };
  renderThread();
  renderComposer();
  const ctrl = new AbortController();
  state.stream = ctrl;
  try {
    await streamEvents(
      `/api/chats/${chatId}/messages`,
      {
        method: 'POST',
        body: { text, focusJobId: state.focusJobId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        signal: ctrl.signal,
      },
      onEvent,
    );
  } catch (err) {
    if (!ctrl.signal.aborted) toast((err as Error).message, 'error');
  }
  if (!ctrl.signal.aborted && state.chatId === chatId) await finishLive(chatId);
}

async function finishLive(chatId: string) {
  state.stream = null;
  try {
    const res = await api<{ chat: { turns: Turn[] }; context: { transcriptTokens: number } }>('GET', `/api/chats/${chatId}`);
    state.turns = res.chat.turns;
    state.transcriptTokens = res.context.transcriptTokens;
  } catch {
    /* keep what we have */
  }
  state.live = null;
  renderThread();
  renderComposer();
  renderTopbar();
  if (state.tab === 'activity') renderWorkspace();
}

let liveTimer: number | null = null;
function scheduleLive() {
  if (liveTimer !== null) return;
  liveTimer = window.setTimeout(() => {
    liveTimer = null;
    renderLiveBlock();
    updateTopCtx();
    if (state.tab === 'activity') renderWorkspace();
  }, 150);
}

function onEvent(e: AgentEvent) {
  if (!state.live) return;
  applyEvent(state.live.activity, e);
  switch (e.type) {
    case 'chat_title': {
      const c = state.chats.find((x) => x.id === state.chatId);
      if (c) c.title = e.title;
      renderSidebar();
      break;
    }
    case 'data_changed':
      void onDataChanged(e.entity, e.jobId);
      break;
    case 'turn_end':
      state.live.answer = e.answer;
      state.live.done = true;
      break;
    case 'error':
      toast(e.message, 'error');
      break;
  }
  scheduleLive();
}

function nearBottom() {
  const t = els.thread;
  return t.scrollHeight - t.scrollTop - t.clientHeight < 120;
}

function renderTurnBlock(user: string, activity: Activity, answerMd: string, opts: { key: string; live: boolean; status?: string }) {
  const actKey = `${opts.key}:activity`;
  const act = h('details.activity-wrap', { 'data-key': actKey }) as HTMLDetailsElement;
  act.open = openState.isOpen(actKey, opts.live);
  act.addEventListener('toggle', () => openState.set(actKey, act.open));
  act.append(
    h('summary', opts.live ? h('span.spinner') : null, h('span', opts.live ? 'Agents working… ' : 'Agent activity · '), h('span.muted', activitySummary(activity))),
    renderActivity(activity, openState),
  );
  return h(
    'div.turn',
    h('div.msg.user', h('div.bubble', user)),
    h(
      'div.msg.assistant',
      h('div.avatar.bot', 'AI'),
      h(
        'div.assistant-body',
        act,
        answerMd ? h('div.answer.md', { html: renderMarkdown(answerMd) }) : opts.live ? h('div.answer.muted', 'Thinking…') : null,
        opts.status === 'error' ? h('div.run-error', 'This reply failed.') : null,
      ),
    ),
  );
}

function renderLiveBlock() {
  if (!state.live || !els.liveBlock) return;
  const stick = nearBottom();
  const answer = state.live.answer ?? liveAnswer(state.live.activity);
  const block = renderTurnBlock(state.live.userText, state.live.activity, answer, { key: 'live', live: !state.live.done });
  els.liveBlock.replaceWith(block);
  els.liveBlock = block;
  if (stick) els.thread.scrollTop = els.thread.scrollHeight;
}

function renderThread() {
  if (!els.thread) return;
  const items: HTMLElement[] = state.turns.map((t) =>
    renderTurnBlock(t.user, t.activity, t.answer, { key: `turn:${t.id}`, live: false, status: t.status }),
  );
  els.liveBlock = undefined;
  if (state.live) {
    els.liveBlock = renderTurnBlock(state.live.userText, state.live.activity, '', { key: 'live', live: true });
    items.push(els.liveBlock);
  }
  if (!items.length) {
    const suggestions = [
      'Help me build my career profile from scratch.',
      "I've got a job ad — can you tailor a CV to it?",
      'Review my CV for the selected job and suggest improvements.',
    ];
    items.push(
      h(
        'div.welcome',
        h('h2', `Hi ${state.user?.name?.split(' ')[0] || 'there'} 👋`),
        h('p.muted', 'I coordinate a writer and a critic to produce your CV. Tell me about the job you want, or start with your profile.'),
        h('div.suggestions', suggestions.map((s) => h('button.suggestion', { onclick: () => send(s) }, s))),
      ),
    );
  }
  clear(els.thread, items);
  els.thread.scrollTop = els.thread.scrollHeight;
  if (state.live) renderLiveBlock();
}

function renderComposer() {
  if (!els.composer) return;
  const busy = Boolean(state.live);
  const input = h('textarea.input', {
    rows: 3,
    placeholder: busy ? 'Agents are working… you can stop them.' : 'Message the coordinator (Enter to send, Shift+Enter for a new line)',
    disabled: busy,
  }) as HTMLTextAreaElement;
  input.value = store.get('draft') ?? '';
  input.addEventListener('input', () => store.set('draft', input.value));
  const submit = () => {
    const text = input.value.trim();
    if (!text || busy) return;
    input.value = '';
    store.set('draft', null);
    void send(text);
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  const select = h(
    'select.focus-select',
    {
      title: 'The job the coordinator treats as "this job"',
      onchange: (e: Event) => setFocusJob((e.target as HTMLSelectElement).value || null, false),
    },
    h('option', { value: '' }, 'No job selected'),
    state.jobs.map((j) => h('option', { value: j.id, selected: j.id === state.focusJobId }, jobLabel(j))),
  );
  clear(
    els.composer,
    h('div.composer-row', h('span.small.muted', 'Focus job:'), select),
    h(
      'div.composer-row.grow',
      input,
      busy
        ? h('button.danger', { onclick: () => state.chatId && api('POST', `/api/chats/${state.chatId}/stop`).catch(() => {}) }, 'Stop')
        : h('button.primary', { onclick: submit }, 'Send'),
    ),
  );
  if (!busy) input.focus();
}

// ---------------------------------------------------------------- workspace panels

async function onDataChanged(entity: DataEntity, jobId?: string) {
  if (entity === 'jobs' || entity === 'job') {
    await reloadJobs();
    if (entity === 'jobs' && jobId && !state.focusJobId) setFocusJob(jobId, false);
  }
  if (entity === 'cv') void reloadJobs();
  const tabFor: Record<DataEntity, Tab | null> = { profile: 'profile', job: 'job', jobs: null, cv: 'cv', css: 'css', preferences: 'prefs' };
  const tab = tabFor[entity];
  if (!tab) return;
  if (tab !== 'profile' && jobId && jobId !== state.focusJobId) return;
  if (entity === 'css' && state.tab === 'cv') return renderWorkspace(); // preview depends on CSS
  if (state.tab !== tab) return;
  if (state.dirty.has(tab)) {
    state.stale.add(tab);
    renderWorkspace(true);
  } else renderWorkspace();
}

function setTab(tab: Tab) {
  state.tab = tab;
  store.set('tab', tab);
  renderWorkspace();
}

const TABS: [Tab, string][] = [
  ['cv', 'CV'],
  ['css', 'CSS'],
  ['profile', 'Profile'],
  ['job', 'Job'],
  ['prefs', 'Preferences'],
  ['activity', 'Activity'],
  ['skills', 'Skills'],
];

let workspaceToken = 0;
function renderWorkspace(keepEditors = false) {
  if (!els.workspace) return;
  if (keepEditors && state.dirty.has(state.tab)) {
    const banner = els.workspace.querySelector('.stale-banner');
    if (!banner && state.stale.has(state.tab)) {
      els.workspace.querySelector('.panel')?.prepend(
        h(
          'div.stale-banner',
          'An agent changed this while you were editing. ',
          h('button.small', { onclick: () => (state.dirty.delete(state.tab), state.stale.delete(state.tab), renderWorkspace()) }, 'Discard my edits & reload'),
        ),
      );
    }
    return;
  }
  const token = ++workspaceToken;
  const panel = h('div.panel');
  clear(
    els.workspace,
    h('nav.tabs', TABS.map(([id, label]) => h('button.tab', { class: state.tab === id ? 'active' : '', onclick: () => setTab(id) }, label))),
    panel,
  );
  const job = focusJob();
  const needsJob = ['cv', 'css', 'job', 'prefs'].includes(state.tab);
  if (needsJob && !job) {
    panel.append(
      h(
        'div.empty',
        h('p', 'Select a job in the sidebar (or the Focus job menu), or create one.'),
        h('button.primary', { onclick: () => newJob() }, '＋ New job'),
      ),
    );
    return;
  }
  const alive = () => token === workspaceToken;
  const fail = (err: unknown) => alive() && panel.append(h('div.form-error', (err as Error).message));
  switch (state.tab) {
    case 'cv':
      void cvPanel(panel, job!, alive).catch(fail);
      break;
    case 'css':
      void textPanel(panel, {
        key: 'css',
        title: 'Stylesheet (raw CSS)',
        hint: 'This exact CSS is applied to the CV for the preview and the PDF. The writer agent edits it too.',
        load: async () => (await api<{ css: string }>('GET', `/api/jobs/${job!.id}/css`)).css,
        save: async (css) => void (await api('PUT', `/api/jobs/${job!.id}/css`, { css })),
        alive,
      }).catch(fail);
      break;
    case 'profile':
      void jsonPanel(panel, {
        key: 'profile',
        title: 'Profile (JSON)',
        hint: 'Your career facts — the single source of truth for every CV.',
        load: async () => (await api('GET', '/api/profile')).profile,
        save: async (profile) => void (await api('PUT', '/api/profile', { profile })),
        alive,
      }).catch(fail);
      break;
    case 'job':
      void jsonPanel(panel, {
        key: 'job',
        title: `Job (JSON) — ${jobLabel(job!)}`,
        hint: 'The target role. Each job has exactly one CV, stylesheet and preferences.',
        load: async () => (await api('GET', `/api/jobs/${job!.id}`)).job.data,
        save: async (data) => {
          await api('PUT', `/api/jobs/${job!.id}`, { job: data });
          await reloadJobs();
        },
        extra: () => deleteJobButton(job!),
        alive,
      }).catch(fail);
      break;
    case 'prefs':
      void jsonPanel(panel, {
        key: 'prefs',
        title: 'CV preferences (JSON)',
        hint: 'pageSize (A4 | Letter), maxPages, tone, language, sections, emphasis, avoid, notes.',
        load: async () => (await api('GET', `/api/jobs/${job!.id}/preferences`)).preferences,
        save: async (preferences) => void (await api('PUT', `/api/jobs/${job!.id}/preferences`, { preferences })),
        alive,
      }).catch(fail);
      break;
    case 'activity':
      activityPanel(panel);
      break;
    case 'skills':
      void skillsPanel(panel, alive).catch(fail);
      break;
  }
}

function deleteJobButton(job: JobSummary) {
  const key = `job:${job.id}`;
  const confirming = state.confirmDelete === key;
  return h(
    'button.danger.small',
    {
      onclick: async () => {
        if (!confirming) {
          state.confirmDelete = key;
          renderWorkspace();
          return;
        }
        state.confirmDelete = null;
        await api('DELETE', `/api/jobs/${job.id}`);
        setFocusJob(null, false);
        await reloadJobs();
        toast('Job deleted');
      },
    },
    confirming ? 'Click again to delete job, CV & styles' : 'Delete job',
  );
}

async function cvPanel(panel: HTMLElement, job: JobSummary, alive: () => boolean) {
  const { cv } = await api<{ cv: { html: string; updatedAt: string } }>('GET', `/api/jobs/${job.id}/cv`);
  if (!alive()) return;
  const words = cv.html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
  const pdfUrl = `/api/jobs/${job.id}/cv.pdf`;
  const pages = h('span.muted.small', '');
  const stamp = Date.now();
  let editing = state.dirty.has('cv');
  const body = h('div.cv-body');
  const drawPreview = () => {
    clear(body, h('iframe.preview', { sandbox: '', src: `/api/jobs/${job.id}/cv/preview?v=${stamp}`, title: 'CV preview' }));
  };
  const drawEditor = () => {
    const ta = h('textarea.code', { spellcheck: 'false' }) as HTMLTextAreaElement;
    ta.value = cv.html;
    ta.addEventListener('input', () => state.dirty.add('cv'));
    clear(
      body,
      ta,
      h(
        'div.row',
        h('button.primary', {
          onclick: async () => {
            await api('PUT', `/api/jobs/${job.id}/cv`, { html: ta.value });
            state.dirty.delete('cv');
            toast('CV saved');
            renderWorkspace();
          },
        }, 'Save HTML'),
        h('button', { onclick: () => (state.dirty.delete('cv'), renderWorkspace()) }, 'Cancel'),
      ),
    );
  };
  panel.append(
    h(
      'div.panel-head',
      h('h3', jobLabel(job)),
      h(
        'div.row',
        h('span.muted.small', cv.html ? `${words} words` : 'empty'),
        pages,
        h('button.small', { onclick: () => renderWorkspace() }, 'Refresh'),
        h('button.small', { onclick: () => ((editing = !editing), editing ? drawEditor() : (state.dirty.delete('cv'), drawPreview())) }, 'Edit HTML'),
        h('a.button.small', { href: pdfUrl, target: '_blank', rel: 'noopener' }, 'Open PDF'),
        h('a.button.small.primary', { href: `${pdfUrl}?download=1` }, 'Download PDF'),
      ),
    ),
    body,
  );
  if (editing) drawEditor();
  else drawPreview();
  if (cv.html.trim()) {
    fetch(pdfUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.headers.get('x-page-count') : null))
      .then((n) => alive() && n && (pages.textContent = `${n} page${n === '1' ? '' : 's'}`))
      .catch(() => {});
  }
}

interface PanelOpts<T> {
  key: string;
  title: string;
  hint: string;
  load: () => Promise<T>;
  save: (value: T) => Promise<void>;
  extra?: () => HTMLElement;
  alive: () => boolean;
}

async function textPanel(panel: HTMLElement, o: PanelOpts<string>) {
  const value = await o.load();
  if (!o.alive()) return;
  const ta = h('textarea.code', { spellcheck: 'false' }) as HTMLTextAreaElement;
  ta.value = value;
  ta.addEventListener('input', () => state.dirty.add(o.key));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      ta.setRangeText('  ', ta.selectionStart, ta.selectionEnd, 'end');
      state.dirty.add(o.key);
    }
  });
  panel.append(
    h('div.panel-head', h('h3', o.title), h('div.row', o.extra?.())),
    h('p.muted.small', o.hint),
    ta,
    h(
      'div.row',
      h('button.primary', {
        onclick: async () => {
          try {
            await o.save(ta.value);
            state.dirty.delete(o.key);
            state.stale.delete(o.key);
            toast('Saved');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        },
      }, 'Save'),
      h('button', { onclick: () => (state.dirty.delete(o.key), state.stale.delete(o.key), renderWorkspace()) }, 'Revert'),
    ),
  );
}

async function jsonPanel(panel: HTMLElement, o: PanelOpts<any>) {
  return textPanel(panel, {
    ...o,
    load: async () => JSON.stringify(await o.load(), null, 2),
    save: async (text) => {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (err) {
        throw new Error(`Invalid JSON: ${(err as Error).message}`);
      }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Top level must be a JSON object');
      await o.save(value);
    },
  });
}

function activityPanel(panel: HTMLElement) {
  const activity = state.live?.activity ?? state.turns[state.turns.length - 1]?.activity;
  panel.append(
    h('div.panel-head', h('h3', state.live ? 'Live agent activity' : 'Latest turn activity')),
    h('p.muted.small', 'Every agent run, LLM call, thought, tool call (with full arguments and results) and context estimate. Context = request size ≈ characters ÷ 4; "reported" = prompt tokens from the model.'),
  );
  if (!activity) {
    panel.append(h('div.muted', 'Nothing yet — send a message.'));
    return;
  }
  panel.append(contextTable(activity), renderActivity(activity, openState));
}

async function skillsPanel(panel: HTMLElement, alive: () => boolean) {
  const skills = await api<Record<string, { name: string; description: string; files: string[] }[]>>('GET', '/api/skills');
  if (!alive()) return;
  panel.append(
    h('div.panel-head', h('h3', 'Agent skills')),
    h('p.muted.small', 'Each agent type has its own skills (folders with a SKILL.md, Anthropic Agent Skills format). Agents see the names and descriptions and load the full instructions on demand.'),
  );
  for (const [agent, list] of Object.entries(skills)) {
    panel.append(
      h('h4', h('span.agent-badge', { class: agent }, agent)),
      ...(list.length
        ? list.map((s) =>
            h('div.skill-card', h('code', s.name), h('p', s.description), s.files.length ? h('div.small.muted', `Bundled files: ${s.files.join(', ')}`) : null),
          )
        : [h('div.muted.small', 'No skills')]),
    );
  }
}

document.addEventListener('click', () => document.querySelectorAll('.account.open').forEach((el) => el.classList.remove('open')));
void boot();
