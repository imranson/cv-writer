import { api, type Message, type ServerEvent } from './api.js';
import { renderMarkdown } from './markdown.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  model: $('model-name'),
  contextFill: $('context-fill'),
  contextText: $('context-text'),
  newSession: $<HTMLButtonElement>('new-session'),
  sessionList: $<HTMLUListElement>('session-list'),
  messages: $('messages'),
  composer: $<HTMLFormElement>('composer'),
  input: $<HTMLTextAreaElement>('input'),
  send: $<HTMLButtonElement>('send'),
  stop: $<HTMLButtonElement>('stop'),
  jobSelect: $<HTMLSelectElement>('job-select'),
  pdfLink: $<HTMLAnchorElement>('pdf-link'),
  frame: $<HTMLIFrameElement>('cv-frame'),
  cvEmpty: $('cv-empty'),
  cssEditor: $<HTMLTextAreaElement>('css-editor'),
  cssSave: $<HTMLButtonElement>('css-save'),
  cssRevert: $<HTMLButtonElement>('css-revert'),
  cssStatus: $('css-status'),
  preferences: $('preferences-view'),
  job: $('job-view'),
  profile: $('profile-view'),
};

const state = {
  sessionId: '',
  running: false,
  jobId: '',
  savedCss: '',
  contextWindow: 0,
};

// ---------- context indicator ----------

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n);
}

function showContext(used: number, window: number): void {
  if (!window) return;
  const pct = Math.min(100, (used / window) * 100);
  els.contextFill.style.width = `${pct}%`;
  els.contextFill.classList.toggle('warn', pct >= 60 && pct < 85);
  els.contextFill.classList.toggle('danger', pct >= 85);
  els.contextText.textContent = `${formatTokens(used)} / ${formatTokens(window)} (${pct.toFixed(1)}%)`;
}

// ---------- chat rendering ----------

function scrollToBottom(): void {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addBubble(kind: 'user' | 'assistant' | 'error' | 'notice', text: string): HTMLDivElement {
  const div = document.createElement('div');
  div.className = `bubble ${kind}`;
  if (kind === 'assistant') div.innerHTML = renderMarkdown(text);
  else div.textContent = text;
  els.messages.append(div);
  scrollToBottom();
  return div;
}

function addThinking(text: string, open: boolean): HTMLDetailsElement {
  const details = document.createElement('details');
  details.className = 'thinking';
  details.open = open;
  details.innerHTML = '<summary>Thinking</summary><div class="thinking-text"></div>';
  details.lastElementChild!.textContent = text;
  els.messages.append(details);
  scrollToBottom();
  return details;
}

function activityGroup(open: boolean): HTMLUListElement {
  const last = els.messages.lastElementChild;
  if (last instanceof HTMLDetailsElement && last.classList.contains('activity')) return last.querySelector('ul')!;
  const details = document.createElement('details');
  details.className = 'activity';
  details.open = open;
  details.innerHTML = '<summary>Activity</summary><ul></ul>';
  els.messages.append(details);
  return details.querySelector('ul')!;
}

function addActivity(depth: number, html: string, open: boolean): void {
  const ul = activityGroup(open);
  const li = document.createElement('li');
  li.className = `depth-${Math.min(depth, 2)}`;
  li.innerHTML = html;
  ul.append(li);
  const summary = ul.parentElement!.querySelector('summary')!;
  summary.textContent = `Activity (${ul.children.length})`;
  scrollToBottom();
}

function esc(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderHistory(messages: Message[]): void {
  els.messages.innerHTML = '';
  for (const m of messages) {
    if (m.role === 'user') addBubble('user', m.content);
    else if (m.role === 'assistant') {
      if (m.thinking?.trim()) addThinking(m.thinking, false);
      if (m.content.trim()) addBubble('assistant', m.content);
      for (const call of m.tool_calls ?? []) addActivity(0, `<span class="agent">coordinator</span> → ${esc(call.function.name)}`, false);
    } else if (m.role === 'tool' && m.content.startsWith('Error:')) {
      addActivity(0, `<span class="fail">✗ ${esc(m.tool_name ?? '')}: ${esc(m.content.slice(0, 160))}</span>`, false);
    }
  }
  if (messages.length === 0) {
    addBubble('notice', 'Say hello to start. The coordinator will build your profile, capture the job and get your CV written.');
  }
}

// ---------- sessions ----------

async function refreshSessions(): Promise<void> {
  const sessions = await api.sessions();
  els.sessionList.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    li.classList.toggle('active', s.id === state.sessionId);
    const open = document.createElement('button');
    open.className = 'open';
    open.textContent = `${s.running ? '● ' : ''}${s.title}`;
    open.title = s.title;
    open.onclick = () => void openSession(s.id);
    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = '×';
    del.title = 'Delete chat';
    del.onclick = async () => {
      if (!confirm(`Delete chat "${s.title}"?`)) return;
      await api.deleteSession(s.id);
      if (s.id === state.sessionId) state.sessionId = '';
      await refreshSessions();
      if (!state.sessionId) await openLatestOrNew();
    };
    li.append(open, del);
    els.sessionList.append(li);
  }
}

async function openSession(id: string): Promise<void> {
  state.sessionId = id;
  localStorage.setItem('sessionId', id);
  const session = await api.session(id);
  renderHistory(session.messages);
  if (session.usage) showContext(session.usage.usedTokens, session.usage.contextWindow);
  else showContext(0, state.contextWindow);
  setRunning(session.running);
  if (session.running) void pollWhileRunning(id);
  await refreshSessions();
}

async function openLatestOrNew(): Promise<void> {
  const sessions = await api.sessions();
  const remembered = localStorage.getItem('sessionId');
  const target = sessions.find((s) => s.id === remembered) ?? sessions[0];
  if (target) await openSession(target.id);
  else await openSession((await api.createSession()).id);
}

/** A run started in another tab (or before a reload) keeps going server-side; follow it. */
async function pollWhileRunning(id: string): Promise<void> {
  addBubble('notice', 'The coordinator is still working on this chat…');
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    if (state.sessionId !== id) return;
    const session = await api.session(id);
    if (!session.running) {
      await openSession(id);
      await refreshWorkspace();
      return;
    }
  }
}

// ---------- sending ----------

function setRunning(running: boolean): void {
  state.running = running;
  els.send.disabled = running;
  els.stop.hidden = !running;
}

let refreshTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleWorkspaceRefresh(preferJobId?: string): void {
  if (preferJobId) state.jobId = preferJobId;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshWorkspace(), 250);
}

async function sendMessage(text: string): Promise<void> {
  if (!state.sessionId || state.running) return;
  setRunning(true);
  addBubble('user', text);
  let bubble: HTMLDivElement | null = null;
  let buffer = '';
  let thought: HTMLDetailsElement | null = null;
  let thoughtBuffer = '';
  let first = true;

  // Reasoning stays open while it streams and collapses once the model answers or uses a tool.
  const endThought = () => {
    if (thought) thought.open = false;
    thought = null;
  };

  const handle = (event: ServerEvent) => {
    if (first) {
      first = false;
      void refreshSessions(); // shows the new title and the running marker
    }
    switch (event.type) {
      case 'delta':
        if (event.thinking) {
          if (!thought) {
            thought = addThinking('', true);
            thoughtBuffer = '';
          }
          thoughtBuffer += event.thinking;
          thought.lastElementChild!.textContent = thoughtBuffer;
          scrollToBottom();
        }
        if (!event.content) return;
        endThought();
        if (!bubble) {
          bubble = addBubble('assistant', '');
          buffer = '';
        }
        buffer += event.content;
        bubble.innerHTML = renderMarkdown(buffer);
        scrollToBottom();
        return;
      case 'message':
        endThought();
        if (!bubble && event.content.trim()) addBubble('assistant', event.content);
        bubble = null;
        return;
      case 'tool_call':
        endThought();
        bubble = null; // text after tool use goes in a new bubble
        addActivity(event.depth, `<span class="agent">${esc(event.agent)}</span> → ${esc(event.name)}`, true);
        return;
      case 'tool_result':
        if (!event.ok) addActivity(event.depth, `<span class="fail">✗ ${esc(event.name)}: ${esc(event.preview.slice(0, 160))}</span>`, true);
        return;
      case 'agent_start':
        addActivity(event.depth, `<span class="agent">${esc(event.agent)}</span> started`, true);
        return;
      case 'agent_end':
        addActivity(event.depth, `<span class="agent">${esc(event.agent)}</span> <span class="${event.ok ? 'ok' : 'fail'}">${event.ok ? 'finished ✓' : 'stopped'}</span>`, true);
        return;
      case 'context':
        if (event.depth === 0) showContext(event.usedTokens, event.contextWindow);
        return;
      case 'data_changed':
        scheduleWorkspaceRefresh(event.kind === 'cv' ? event.id : undefined);
        return;
      case 'stopped':
        addBubble('notice', 'Stopped.');
        return;
      case 'error':
        addBubble('error', event.message);
        return;
      case 'done':
        return;
    }
  };

  try {
    await api.send(state.sessionId, text, handle);
  } catch (err) {
    addBubble('error', (err as Error).message);
  } finally {
    setRunning(false);
    endThought();
    els.messages.querySelectorAll('details.activity').forEach((d) => ((d as HTMLDetailsElement).open = false));
    await refreshSessions();
    await refreshWorkspace();
  }
}

// ---------- workspace panel ----------

function showJson(el: HTMLElement, value: unknown, empty: string): void {
  el.textContent = value && Object.keys(value as object).length ? JSON.stringify(value, null, 2) : empty;
}

async function refreshWorkspace(): Promise<void> {
  const jobs = await api.jobs();
  if (!jobs.some((j) => j.id === state.jobId)) state.jobId = (jobs.find((j) => j.hasCv) ?? jobs[0])?.id ?? '';
  els.jobSelect.innerHTML = jobs.length
    ? jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.title)}${j.hasCv ? '' : ' (no CV yet)'}</option>`).join('')
    : '<option value="">No jobs yet</option>';
  els.jobSelect.value = state.jobId;
  await showJob(state.jobId);
}

async function showJob(jobId: string): Promise<void> {
  if (!jobId) {
    els.frame.hidden = true;
    els.cvEmpty.hidden = false;
    els.pdfLink.setAttribute('aria-disabled', 'true');
    showJson(els.preferences, null, 'No CV selected.');
    showJson(els.job, null, 'No job selected.');
    await showProfile(undefined);
    return;
  }
  const [cv, job] = await Promise.all([api.cv(jobId), api.job(jobId).catch(() => ({}) as Record<string, unknown>)]);
  els.frame.hidden = !cv.exists;
  els.cvEmpty.hidden = cv.exists;
  if (cv.exists) els.frame.src = `/api/cvs/${jobId}/document?t=${Date.now()}`;
  els.pdfLink.href = `/api/cvs/${jobId}/pdf?download=1`;
  els.pdfLink.setAttribute('aria-disabled', String(!cv.exists));
  if (els.cssEditor.value === state.savedCss || jobId !== els.cssEditor.dataset.jobId) {
    els.cssEditor.value = cv.css; // don't clobber unsaved edits for the same CV
  }
  els.cssEditor.dataset.jobId = jobId;
  state.savedCss = cv.css;
  els.cssStatus.textContent = '';
  showJson(els.preferences, cv.preferences, 'No preferences saved for this CV yet.');
  showJson(els.job, job, 'Job not found.');
  await showProfile(typeof job.profileId === 'string' ? job.profileId : undefined);
}

async function showProfile(profileId: string | undefined): Promise<void> {
  const id = profileId ?? (await api.profiles())[0]?.id;
  const profile = id ? await api.profile(id).catch(() => undefined) : undefined;
  showJson(els.profile, profile, 'No profile yet.');
}

// ---------- wiring ----------

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = '';
  void sendMessage(text);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    els.composer.requestSubmit();
  }
});
els.stop.addEventListener('click', () => void api.stop(state.sessionId));
els.newSession.addEventListener('click', async () => {
  const session = await api.createSession();
  await openSession(session.id);
  els.input.focus();
});
els.jobSelect.addEventListener('change', () => {
  state.jobId = els.jobSelect.value;
  void showJob(state.jobId);
});
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((t) => t.classList.toggle('active', t === tab));
    document.querySelectorAll<HTMLElement>('.panel').forEach((p) => p.classList.toggle('active', p.dataset.panel === tab.dataset.tab));
  });
});
els.cssEditor.addEventListener('input', () => {
  els.cssStatus.textContent = els.cssEditor.value === state.savedCss ? '' : 'Unsaved changes';
});
els.cssEditor.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    els.cssEditor.setRangeText('  ', els.cssEditor.selectionStart, els.cssEditor.selectionEnd, 'end');
  }
});
els.cssSave.addEventListener('click', async () => {
  if (!state.jobId) return;
  try {
    const cv = await api.saveCss(state.jobId, els.cssEditor.value);
    state.savedCss = cv.css;
    els.cssStatus.textContent = 'Saved';
    if (cv.exists) els.frame.src = `/api/cvs/${state.jobId}/document?t=${Date.now()}`;
  } catch (err) {
    els.cssStatus.textContent = `Save failed: ${(err as Error).message}`;
  }
});
els.cssRevert.addEventListener('click', () => {
  els.cssEditor.value = state.savedCss;
  els.cssStatus.textContent = '';
});

async function init(): Promise<void> {
  const status = await api.status();
  state.contextWindow = status.contextWindow;
  els.model.textContent = `${status.models.coordinator}${status.webSearch ? '' : ' · web search off'}`;
  await openLatestOrNew();
  await refreshWorkspace();
}

void init();
