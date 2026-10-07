import { renderHtml } from '../../src/cv/render.js';
import { api, ApiError, stream, type AppConfigView, type CheckReport, type CvVersion, type Job, type Style, type VersionSummary } from './api.js';
import { $, formatTime, h } from './dom.js';
import { renderMarkdown } from './markdown.js';
import { auditView, buildStyleForm, jobView, profileView, reviewView, verdictLabel, versionOptionLabel } from './views.js';

const AGENT_LABEL: Record<string, string> = { coordinator: 'Coach', writer: 'Writer', critic: 'Critic' };

interface State {
  config?: AppConfigView;
  sessionId?: string;
  activeJobId?: string;
  jobs: Job[];
  versions: VersionSummary[];
  selectedVersion?: number;
  cv?: CvVersion & { currentChecks: CheckReport };
  style?: Style;
  busy: boolean;
  tab: string;
}

const state: State = { jobs: [], versions: [], busy: false, tab: 'preview' };

const els = {
  messages: $('#messages'),
  status: $('#status'),
  input: $('#input') as HTMLTextAreaElement,
  send: $('#send') as HTMLButtonElement,
  composer: $('#composer') as HTMLFormElement,
  sessionSelect: $('#session-select') as HTMLSelectElement,
  jobSelect: $('#job-select') as HTMLSelectElement,
  versionSelect: $('#version-select') as HTMLSelectElement,
  versionBadge: $('#version-badge'),
  preview: $('#preview') as HTMLIFrameElement,
  stylePreview: $('#style-preview') as HTMLIFrameElement,
  styleForm: $('#style-form'),
  pdfPreview: $('#pdf-preview') as HTMLButtonElement,
  pdfDownload: $('#pdf-download') as HTMLAnchorElement,
  mdDownload: $('#md-download') as HTMLAnchorElement,
};

function storageGet(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function storageSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private mode
  }
}

// ---------- conversation ----------

function scrollToEnd(): void {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function addBubble(role: 'user' | 'assistant', text: string, at?: string): HTMLElement {
  const body = h('div', { class: 'bubble-body' });
  if (role === 'assistant') body.innerHTML = renderMarkdown(text);
  else body.textContent = text;
  const bubble = h('div', { class: `bubble ${role}` }, body, at ? h('time', {}, formatTime(at)) : null);
  els.messages.append(bubble);
  scrollToEnd();
  return bubble;
}

function addEvent(text: string, kind = 'event'): HTMLElement {
  const el = h('div', { class: `event ${kind}` }, text);
  els.messages.append(el);
  scrollToEnd();
  return el;
}

function setStatus(text?: string): void {
  els.status.hidden = !text;
  els.status.textContent = text ?? '';
}

function setBusy(busy: boolean): void {
  state.busy = busy;
  els.send.disabled = busy;
  els.send.textContent = busy ? 'Working…' : 'Send';
  els.sessionSelect.disabled = busy;
  if (!busy) setStatus();
}

async function loadSessions(selectId?: string): Promise<void> {
  const sessions = await api.sessions();
  els.sessionSelect.replaceChildren(
    ...sessions.map((s) => h('option', { value: s.id, selected: s.id === selectId }, `${formatTime(s.updatedAt)}${s.preview ? ` — ${s.preview.slice(0, 40)}` : ' — new conversation'}`)),
  );
}

async function openSession(id: string): Promise<void> {
  const session = await api.session(id);
  state.sessionId = session.id;
  state.activeJobId = session.activeJobId;
  storageSet('cv-writer.session', session.id);
  els.messages.replaceChildren();
  for (const t of session.transcript) {
    if (t.role === 'event') addEvent(t.text, t.text.startsWith('Error:') ? 'event error' : 'event');
    else addBubble(t.role, t.text, t.at);
  }
  await refreshJobs();
  if (session.busy) {
    // A turn started before this page loaded is still running on the server; pick up its result.
    addEvent('The coach is still working on your last message…');
    setBusy(true);
    setStatus('Waiting for the coach to finish…');
    while ((await api.session(id).catch(() => ({ busy: false }))).busy && state.sessionId === id) await new Promise((r) => setTimeout(r, 4000));
    setBusy(false);
    if (state.sessionId === id) await openSession(id);
  } else if (session.transcript.length === 0) {
    await converse(`/api/sessions/${encodeURIComponent(id)}/open`);
  }
}

/** Streams one coordinator turn into the chat, showing what each agent is doing. */
async function converse(url: string, body?: unknown): Promise<void> {
  setBusy(true);
  setStatus('Coach is thinking…');
  const pendingBody = h('div', { class: 'bubble-body' });
  const pending = h('div', { class: 'bubble assistant pending' }, pendingBody);
  els.messages.append(pending);
  let streamed = '';
  const tools = new Map<string, HTMLElement>();
  let gotReply = false;
  const refreshes = new Set<string>();
  try {
    for await (const { event, data } of stream(url, body)) {
      const d = data as Record<string, unknown>;
      switch (event) {
        case 'delta':
          if (d.reset) streamed = '';
          if (typeof d.content === 'string') streamed += d.content;
          if (typeof d.thinking === 'string' && !streamed) setStatus('Coach is thinking…');
          pendingBody.textContent = streamed;
          if (streamed) setStatus('Coach is writing…');
          scrollToEnd();
          break;
        case 'note':
          streamed = '';
          pendingBody.textContent = '';
          els.messages.insertBefore(h('div', { class: `event note agent-${String(d.agent)}` }, String(d.text)), pending);
          break;
        case 'tool_start': {
          streamed = '';
          pendingBody.textContent = '';
          const agent = String(d.agent);
          const el = h('div', { class: `event tool agent-${agent}` }, h('span', { class: 'agent-tag' }, AGENT_LABEL[agent] ?? agent), ` ${String(d.label)}…`);
          tools.set(`${agent}:${String(d.tool)}`, el);
          els.messages.insertBefore(el, pending);
          setStatus(`${AGENT_LABEL[agent] ?? agent}: ${String(d.label)}…`);
          scrollToEnd();
          break;
        }
        case 'tool_end': {
          const el = tools.get(`${String(d.agent)}:${String(d.tool)}`);
          if (el) {
            el.lastChild!.textContent = ` ${String(d.label)} ${d.ok ? '✓' : '✗'}`;
            el.classList.add(d.ok ? 'ok' : 'failed');
          }
          setStatus('Coach is thinking…');
          break;
        }
        case 'activity': {
          const agent = String(d.agent);
          els.messages.insertBefore(h('div', { class: `event activity agent-${agent}` }, h('span', { class: 'agent-tag' }, AGENT_LABEL[agent] ?? agent), ` ${String(d.text)}`), pending);
          setStatus(String(d.text));
          scrollToEnd();
          break;
        }
        case 'progress': {
          const agent = String(d.agent);
          const tokens = Math.round(Number(d.chars) / 4);
          setStatus(`${AGENT_LABEL[agent] ?? agent} is working… ${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens so far`);
          break;
        }
        case 'state':
          for (const c of (d.changed as string[]) ?? []) refreshes.add(c);
          void applyRefreshes(refreshes);
          break;
        case 'reply':
          gotReply = true;
          pending.remove();
          addBubble('assistant', String(d.text), new Date().toISOString());
          break;
        case 'error':
          addEvent(`Something went wrong: ${String(d.message)}`, 'event error');
          break;
      }
    }
  } catch (err) {
    addEvent(err instanceof ApiError ? err.message : `Connection problem: ${(err as Error).message}`, 'event error');
  } finally {
    if (!gotReply) pending.remove();
    setBusy(false);
    await applyRefreshes(new Set(['profile', 'jobs', 'cvs']));
    void loadSessions(state.sessionId);
    els.input.focus();
  }
}

let refreshTimer: number | undefined;
function applyRefreshes(pending: Set<string>): Promise<void> {
  return new Promise((resolve) => {
    window.clearTimeout(refreshTimer);
    refreshTimer = window.setTimeout(async () => {
      const what = new Set(pending);
      pending.clear();
      try {
        if (what.has('jobs')) {
          if (state.sessionId) state.activeJobId = (await api.session(state.sessionId)).activeJobId ?? state.activeJobId;
          await refreshJobs();
        } else if (what.has('cvs')) await refreshVersions(true);
        if (what.has('style')) {
          state.style = await api.style();
          renderStyleForm();
          renderPreviews();
        }
        if (what.has('profile') && state.tab === 'profile') await renderTab('profile');
        if (what.has('cvs') && state.tab === 'review') await renderTab('review');
        if (what.has('jobs') && state.tab === 'job') await renderTab('job');
      } catch (err) {
        console.warn(err);
      }
      resolve();
    }, 250);
  });
}

// ---------- workspace ----------

function activeJob(): Job | undefined {
  return state.jobs.find((j) => j.id === state.activeJobId);
}

async function refreshJobs(): Promise<void> {
  state.jobs = await api.jobs();
  if (!state.activeJobId && state.jobs[0]) state.activeJobId = state.jobs[0].id;
  els.jobSelect.replaceChildren(
    ...(state.jobs.length ? state.jobs.map((j) => h('option', { value: j.id, selected: j.id === state.activeJobId }, `${j.title} — ${j.company}`)) : [h('option', { value: '' }, 'No jobs yet')]),
  );
  await refreshVersions(true);
}

async function refreshVersions(selectLatest: boolean): Promise<void> {
  const job = activeJob();
  state.versions = job ? await api.versions(job.id) : [];
  const latest = state.versions.at(-1)?.version;
  if (selectLatest || !state.versions.some((v) => v.version === state.selectedVersion)) state.selectedVersion = latest;
  els.versionSelect.replaceChildren(
    ...(state.versions.length
      ? [...state.versions].reverse().map((v) => h('option', { value: String(v.version), selected: v.version === state.selectedVersion }, versionOptionLabel(v)))
      : [h('option', { value: '' }, 'No CV yet')]),
  );
  await loadSelectedVersion();
}

async function loadSelectedVersion(): Promise<void> {
  const job = activeJob();
  state.cv = job && state.selectedVersion ? await api.version(job.id, state.selectedVersion) : undefined;
  const summary = state.versions.find((v) => v.version === state.selectedVersion);
  els.versionBadge.textContent = summary ? `${summary.status === 'approved' ? 'Approved' : 'Draft'} · ${summary.score !== undefined ? `${summary.score}/100 ${verdictLabel(summary.verdict)}` : 'not reviewed'}` : '';
  els.versionBadge.className = `badge ${summary?.status ?? ''} verdict-${summary?.verdict ?? 'none'}`;
  const enabled = Boolean(job && state.cv);
  const pdfOk = enabled && Boolean(state.config?.pdfAvailable);
  els.pdfPreview.disabled = !pdfOk;
  for (const [a, href] of [
    [els.pdfDownload, pdfOk && job && state.cv ? api.pdfUrl(job.id, state.cv.version, true) : ''],
    [els.mdDownload, enabled && job && state.cv ? api.markdownUrl(job.id, state.cv.version) : ''],
  ] as const) {
    a.classList.toggle('disabled', !href);
    if (href) a.href = href;
    else a.removeAttribute('href');
  }
  renderPreviews();
  if (state.tab === 'review') await renderTab('review');
}

function placeholderPage(text: string): string {
  return `<!doctype html><html><body style="font-family:system-ui;color:#777;display:grid;place-items:center;height:90vh;margin:0;background:#f4f4f6"><p style="max-width:28em;text-align:center">${text}</p></body></html>`;
}

function renderPreviews(): void {
  const html =
    state.cv && state.style
      ? renderHtml(state.cv.document, state.style)
      : placeholderPage(state.jobs.length ? 'No CV for this job yet. Ask your coach to draft one.' : 'Your CV will appear here once your coach has your profile and a job listing.');
  els.preview.srcdoc = html;
  els.stylePreview.srcdoc = html;
}

let styleSave: Promise<unknown> = Promise.resolve();
function renderStyleForm(): void {
  if (!state.config || !state.style) return;
  buildStyleForm(els.styleForm, state.config, state.style, (patch) => {
    // Show the change at once, then persist it (the PDF and the coach use the saved style).
    if (!('preset' in patch) && state.style) {
      state.style = { ...state.style, ...patch };
      renderPreviews();
    }
    styleSave = styleSave
      .then(() => api.saveStyle(patch))
      .then((saved) => {
        const presetApplied = 'preset' in patch || Object.keys(patch).length > 3;
        state.style = saved;
        renderPreviews();
        if (presetApplied) renderStyleForm();
      })
      .catch((err: Error) => addEvent(`Style not saved: ${err.message}`, 'event error'));
  });
}

async function renderTab(tab: string): Promise<void> {
  const target = document.querySelector<HTMLElement>(`[data-panel="${tab}"] .scroll`);
  if (tab === 'profile' && target) {
    const [{ profile, gaps }, history] = await Promise.all([api.profile(), api.profileHistory()]);
    target.replaceChildren(profileView(profile, gaps, history));
  } else if (tab === 'job' && target) {
    target.replaceChildren(jobView(activeJob()));
  } else if (tab === 'review' && target) {
    target.replaceChildren(reviewView(state.cv));
  } else if (tab === 'audit' && target) {
    target.replaceChildren(auditView(await api.audit()));
  }
}

function selectTab(tab: string): void {
  state.tab = tab;
  for (const b of document.querySelectorAll<HTMLElement>('.tab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const p of document.querySelectorAll<HTMLElement>('.panel')) p.classList.toggle('active', p.dataset.panel === tab);
  void renderTab(tab).catch((err: Error) => addEvent(err.message, 'event error'));
}

// ---------- wiring ----------

function wire(): void {
  els.composer.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = els.input.value.trim();
    if (!text || state.busy || !state.sessionId) return;
    els.input.value = '';
    addBubble('user', text, new Date().toISOString());
    void converse(`/api/sessions/${encodeURIComponent(state.sessionId)}/messages`, { text });
  });
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      els.composer.requestSubmit();
    }
  });
  $('#new-session').addEventListener('click', async () => {
    if (state.busy) return;
    const s = await api.newSession();
    await loadSessions(s.id);
    await openSession(s.id);
  });
  els.sessionSelect.addEventListener('change', () => void openSession(els.sessionSelect.value));
  els.jobSelect.addEventListener('change', async () => {
    state.activeJobId = els.jobSelect.value;
    if (state.sessionId && !state.busy) await api.setActiveJob(state.sessionId, state.activeJobId).catch(() => undefined);
    await refreshVersions(true);
    if (state.tab === 'job') await renderTab('job');
  });
  els.versionSelect.addEventListener('change', async () => {
    state.selectedVersion = Number(els.versionSelect.value) || undefined;
    await loadSelectedVersion();
  });
  els.pdfPreview.addEventListener('click', async () => {
    const job = activeJob();
    if (!job || !state.cv) return;
    await styleSave;
    window.open(api.pdfUrl(job.id, state.cv.version), '_blank', 'noopener');
  });
  els.pdfDownload.addEventListener('click', async (e) => {
    if (els.pdfDownload.classList.contains('disabled')) e.preventDefault();
  });
  for (const b of document.querySelectorAll<HTMLElement>('.tab')) b.addEventListener('click', () => selectTab(b.dataset.tab!));
}

async function start(): Promise<void> {
  wire();
  try {
    const [config, style] = await Promise.all([api.config(), api.style()]);
    state.config = config;
    state.style = style;
    if (!config.pdfAvailable) els.pdfPreview.title = 'PDF needs Chrome or Chromium on the server';
    renderStyleForm();
    const sessions = await api.sessions();
    const remembered = storageGet('cv-writer.session');
    const id = sessions.find((s) => s.id === remembered)?.id ?? sessions[0]?.id ?? (await api.newSession()).id;
    await loadSessions(id);
    await openSession(id);
  } catch (err) {
    addEvent(`Could not start: ${(err as Error).message}`, 'event error');
  }
}

void start();
