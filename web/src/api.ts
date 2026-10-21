import type { StreamEvent } from '../../src/agents/types';
import type { ChatSession, CvPreferences, Job, JobSummary, Profile, PublicUser, SessionSummary } from '../../src/store/types';
import { createSSEParser } from './sse';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
  return data as T;
}

export interface AgentInfo {
  agent: 'coordinator' | 'writer' | 'critic';
  model: string;
  contextWindow: number;
  tools: string[];
  skills: { name: string; description: string }[];
}

export type DoneEvent = { type: 'done'; text: string; title: string };

export const api = {
  me: () => request<{ user: PublicUser }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => request<{ user: PublicUser }>('POST', '/api/auth/login', { email, password }),
  register: (email: string, name: string, password: string) =>
    request<{ user: PublicUser }>('POST', '/api/auth/register', { email, name, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout'),
  system: () => request<{ now: string; agents: AgentInfo[] }>('GET', '/api/system'),

  profile: () => request<{ profile: Profile }>('GET', '/api/profile'),
  saveProfile: (profile: Profile) => request<{ profile: Profile }>('PUT', '/api/profile', { profile }),

  jobs: () => request<{ jobs: JobSummary[] }>('GET', '/api/jobs'),
  job: (id: string) => request<{ job: Job }>('GET', `/api/jobs/${id}`),
  createJob: (job: Partial<Job>) => request<{ job: Job }>('POST', '/api/jobs', job),
  updateJob: (id: string, job: Partial<Job>) => request<{ job: Job }>('PUT', `/api/jobs/${id}`, job),
  deleteJob: (id: string) => request<{ ok: true }>('DELETE', `/api/jobs/${id}`),
  css: (id: string) => request<{ css: string }>('GET', `/api/jobs/${id}/css`),
  saveCss: (id: string, css: string) => request<{ ok: true }>('PUT', `/api/jobs/${id}/css`, { css }),
  preferences: (id: string) => request<{ preferences: CvPreferences }>('GET', `/api/jobs/${id}/preferences`),
  savePreferences: (id: string, preferences: CvPreferences) =>
    request<{ preferences: CvPreferences }>('PUT', `/api/jobs/${id}/preferences`, { preferences }),

  sessions: () => request<{ sessions: SessionSummary[] }>('GET', '/api/sessions'),
  session: (id: string) => request<{ session: ChatSession; running: boolean }>('GET', `/api/sessions/${id}`),
  createSession: () => request<{ session: ChatSession }>('POST', '/api/sessions', {}),
  renameSession: (id: string, title: string) => request<{ session: ChatSession }>('PATCH', `/api/sessions/${id}`, { title }),
  deleteSession: (id: string) => request<{ ok: true }>('DELETE', `/api/sessions/${id}`),

  async pdf(jobId: string): Promise<{ blob: Blob; pages: number }> {
    const res = await fetch(`/api/jobs/${jobId}/cv.pdf`, { credentials: 'same-origin' });
    if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return { blob: await res.blob(), pages: Number(res.headers.get('X-Page-Count')) || 0 };
  },

  /** Sends a chat message and streams the agents' events until the turn finishes. */
  async sendMessage(
    sessionId: string,
    content: string,
    activeJobId: string | undefined,
    onEvent: (e: StreamEvent | DoneEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const res = await fetch(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({ content, activeJobId }),
      credentials: 'same-origin',
      signal,
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      throw new ApiError(res.status, data.error || `HTTP ${res.status}`);
    }
    const parser = createSSEParser((msg) => {
      try {
        onEvent(JSON.parse(msg.data));
      } catch {
        // ignore malformed frames
      }
    });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(value);
    }
    parser.end();
  },
};
