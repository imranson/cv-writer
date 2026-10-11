import { readSse } from './sse.ts';
import type {
  AppInfo,
  CheckFinding,
  Critique,
  CvVersion,
  Job,
  JobSummary,
  ServerEvent,
  Session,
  SessionSummary,
  Skill,
  SkillMeta,
  StylePreset,
} from './types.ts';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(data?.error ?? `${method} ${url} failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const get = <T>(url: string) => request<T>('GET', url);
const enc = encodeURIComponent;

export const api = {
  config: () => get<AppInfo>('/api/config'),

  profile: () => get<{ markdown: string }>('/api/profile'),
  saveProfile: (markdown: string) => request<{ markdown: string }>('PUT', '/api/profile', { markdown }),

  jobs: () => get<JobSummary[]>('/api/jobs'),
  job: (id: string) => get<Job>(`/api/jobs/${enc(id)}`),
  createJob: (input: { title: string; company: string; listing: string; url?: string }) => request<Job>('POST', '/api/jobs', input),
  updateJob: (id: string, patch: Partial<Pick<Job, 'title' | 'company' | 'listing' | 'url'>>) =>
    request<Job>('PUT', `/api/jobs/${enc(id)}`, patch),
  deleteJob: (id: string) => request<void>('DELETE', `/api/jobs/${enc(id)}`),

  cv: (id: string) => get<{ html: string }>(`/api/jobs/${enc(id)}/cv`),
  saveCv: (id: string, html: string) => request<{ html: string }>('PUT', `/api/jobs/${enc(id)}/cv`, { html }),
  versions: (id: string) => get<CvVersion[]>(`/api/jobs/${enc(id)}/cv/versions`),
  version: (id: string, vid: string) => get<{ html: string }>(`/api/jobs/${enc(id)}/cv/versions/${enc(vid)}`),
  restoreVersion: (id: string, vid: string) => request<{ html: string }>('POST', `/api/jobs/${enc(id)}/cv/versions/${enc(vid)}/restore`),
  style: (id: string) => get<{ css: string }>(`/api/jobs/${enc(id)}/style`),
  saveStyle: (id: string, css: string) => request<{ css: string }>('PUT', `/api/jobs/${enc(id)}/style`, { css }),
  presets: () => get<StylePreset[]>('/api/style-presets'),
  pdfUrl: (id: string, download = false) => `/api/jobs/${enc(id)}/pdf${download ? '?download=1' : `?t=${Date.now()}`}`,

  critiques: (id: string) => get<Critique[]>(`/api/jobs/${enc(id)}/critiques`),
  runCritique: (id: string, focus?: string) => request<Critique>('POST', `/api/jobs/${enc(id)}/critique`, { focus }),
  checks: (id: string) => get<{ pageCount: number | null; findings: CheckFinding[] }>(`/api/jobs/${enc(id)}/checks`),

  sessions: () => get<SessionSummary[]>('/api/sessions'),
  session: (id: string) => get<Session>(`/api/sessions/${enc(id)}`),
  createSession: (jobId?: string | null) => request<Session>('POST', '/api/sessions', { jobId: jobId ?? null }),
  updateSession: (id: string, patch: { title?: string; jobId?: string | null }) => request<Session>('PATCH', `/api/sessions/${enc(id)}`, patch),
  deleteSession: (id: string) => request<void>('DELETE', `/api/sessions/${enc(id)}`),
  stop: (id: string) => request<{ stopped: boolean }>('POST', `/api/sessions/${enc(id)}/stop`),
  compact: (id: string) => request<Session>('POST', `/api/sessions/${enc(id)}/compact`),

  /** Sends a chat message and streams the agent's events until the turn ends. */
  async send(id: string, text: string, onEvent: (e: ServerEvent) => void): Promise<void> {
    const res = await fetch(`/api/sessions/${enc(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
    }
    for await (const { data } of readSse(res.body)) {
      onEvent(JSON.parse(data) as ServerEvent);
    }
  },

  skills: () => get<SkillMeta[]>('/api/skills'),
  skill: (id: string) => get<Skill>(`/api/skills/${enc(id)}`),
  createSkill: (input: Omit<Skill, 'source' | 'overridesBuiltin' | 'id'> & { id?: string }) => request<Skill>('POST', '/api/skills', input),
  updateSkill: (id: string, input: Omit<Skill, 'source' | 'overridesBuiltin' | 'id'>) => request<Skill>('PUT', `/api/skills/${enc(id)}`, input),
  deleteSkill: (id: string) => request<void>('DELETE', `/api/skills/${enc(id)}`),
};
