import { readEventStream } from './sse.js';

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
}

export interface Session {
  id: string;
  title: string;
  updatedAt: string;
  messages: Message[];
  usage?: { usedTokens: number; contextWindow: number };
  running: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  updatedAt: string;
  running: boolean;
}

export interface JobSummary {
  id: string;
  title: string;
  profileId?: string;
  hasCv: boolean;
}

export interface Cv {
  jobId: string;
  exists: boolean;
  html: string;
  css: string;
  preferences: Record<string, unknown>;
  updatedAt?: string;
}

export interface Status {
  models: Record<string, string>;
  contextWindow: number;
  webSearch: boolean;
}

export type ServerEvent =
  | { type: 'delta'; agent: string; depth: number; content?: string; thinking?: string }
  | { type: 'message'; agent: string; depth: number; content: string }
  | { type: 'tool_call'; agent: string; depth: number; name: string; args: unknown }
  | { type: 'tool_result'; agent: string; depth: number; name: string; ok: boolean; preview: string }
  | { type: 'agent_start'; agent: string; depth: number; task: string }
  | { type: 'agent_end'; agent: string; depth: number; ok: boolean }
  | { type: 'context'; agent: string; depth: number; usedTokens: number; contextWindow: number }
  | { type: 'data_changed'; kind: 'profile' | 'job' | 'cv'; id: string }
  | { type: 'done'; text: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export const api = {
  status: () => fetch('/api/status').then((r) => json<Status>(r)),
  sessions: () => fetch('/api/sessions').then((r) => json<SessionSummary[]>(r)),
  createSession: () => fetch('/api/sessions', { method: 'POST' }).then((r) => json<Session>(r)),
  session: (id: string) => fetch(`/api/sessions/${id}`).then((r) => json<Session>(r)),
  deleteSession: (id: string) => fetch(`/api/sessions/${id}`, { method: 'DELETE' }),
  stop: (id: string) => fetch(`/api/sessions/${id}/stop`, { method: 'POST' }),
  jobs: () => fetch('/api/jobs').then((r) => json<JobSummary[]>(r)),
  job: (id: string) => fetch(`/api/jobs/${id}`).then((r) => json<Record<string, unknown>>(r)),
  profiles: () => fetch('/api/profiles').then((r) => json<{ id: string; title: string }[]>(r)),
  profile: (id: string) => fetch(`/api/profiles/${id}`).then((r) => json<Record<string, unknown>>(r)),
  cv: (jobId: string) => fetch(`/api/cvs/${jobId}`).then((r) => json<Cv>(r)),
  saveCss: (jobId: string, css: string) =>
    fetch(`/api/cvs/${jobId}/css`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ css }),
    }).then((r) => json<Cv>(r)),

  async send(id: string, text: string, onEvent: (event: ServerEvent) => void): Promise<void> {
    const response = await fetch(`/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) await json(response);
    await readEventStream<ServerEvent>(response, onEvent);
  },
};
