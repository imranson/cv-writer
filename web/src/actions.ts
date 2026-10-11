import { api } from './api.ts';
import { toast } from './dom.ts';
import { bus, state } from './state.ts';

const LAST_SESSION_KEY = 'cv-writer:last-session';

export async function refreshJobs(): Promise<void> {
  state.jobs = await api.jobs();
  bus.emit('jobs');
}

export async function refreshSessions(): Promise<void> {
  state.sessions = await api.sessions();
  bus.emit('sessions');
}

/** Opens a session by id, or creates a new one when id is null. */
export async function openSession(id: string | null, jobId?: string | null): Promise<void> {
  if (state.running) {
    toast('Wait for the current reply to finish (or press Stop) before switching conversations.');
    return;
  }
  try {
    state.session = id ? await api.session(id) : await api.createSession(jobId ?? state.session?.jobId ?? null);
    localStorage.setItem(LAST_SESSION_KEY, state.session.id);
    bus.emit('session');
    if (!id) await refreshSessions();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export async function restoreLastSession(): Promise<void> {
  const last = localStorage.getItem(LAST_SESSION_KEY);
  const target = state.sessions.find((s) => s.id === last) ?? state.sessions[0];
  if (target) await openSession(target.id);
}

export async function setSessionJob(jobId: string | null): Promise<void> {
  if (!state.session) {
    await openSession(null, jobId);
    return;
  }
  if (state.session.jobId === jobId) {
    bus.emit('session');
    return;
  }
  try {
    const updated = await api.updateSession(state.session.id, { jobId });
    state.session = { ...state.session, jobId: updated.jobId, context: updated.context };
    bus.emit('session');
    void refreshSessions();
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

export async function deleteSession(id: string): Promise<void> {
  await api.deleteSession(id);
  if (state.session?.id === id) {
    state.session = null;
    bus.emit('session');
  }
  await refreshSessions();
}
