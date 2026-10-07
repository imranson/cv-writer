import type { AuditRecord, Check, CheckReport, CvVersion, Job, Profile, Style, TranscriptEntry } from '../../src/domain/schemas.js';
import type { FontChoice } from '../../src/cv/style.js';
import { readSse, type SseMessage } from './sse.js';

export type { AuditRecord, Check, CheckReport, CvVersion, Job, Profile, Style, TranscriptEntry, FontChoice };

export interface AppConfigView {
  models: { coordinator: string; writer: string; critic: string };
  pdfAvailable: boolean;
  fonts: FontChoice[];
  presets: Record<string, Partial<Style>>;
  defaultStyle: Style;
  dataDir: string;
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  preview: string;
}

export interface SessionView {
  id: string;
  activeJobId?: string;
  transcript: TranscriptEntry[];
  busy: boolean;
}

export interface VersionSummary {
  version: number;
  status: 'draft' | 'approved';
  createdAt: string;
  basedOnVersion?: number;
  changeSummary?: string;
  feedback?: string;
  profileRevision: number;
  writerRunId: string;
  errors: number;
  warnings: number;
  words: number;
  score?: number;
  verdict?: string;
  approvedAt?: string;
  lastExport?: { pdf?: string; pages?: number; at: string };
}

export interface HistoryRecord {
  revision: number;
  at: string;
  operation: string;
  actor?: string;
  reason?: string;
  payload: unknown;
}

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
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } } : {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `${method} ${url} failed (${res.status})`);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;

export const api = {
  config: () => request<AppConfigView>('GET', '/api/config'),
  profile: () => request<{ profile: Profile; gaps: string[] }>('GET', '/api/profile'),
  profileHistory: () => request<HistoryRecord[]>('GET', '/api/profile/history'),
  jobs: () => request<Job[]>('GET', '/api/jobs'),
  versions: (jobId: string) => request<VersionSummary[]>('GET', `/api/jobs/${enc(jobId)}/cvs`),
  version: (jobId: string, v: number) => request<CvVersion & { currentChecks: CheckReport }>('GET', `/api/jobs/${enc(jobId)}/cvs/${v}`),
  pdfUrl: (jobId: string, v: number, download = false) => `/api/jobs/${enc(jobId)}/cvs/${v}/pdf${download ? '?download=1' : ''}`,
  markdownUrl: (jobId: string, v: number) => `/api/jobs/${enc(jobId)}/cvs/${v}/markdown`,
  exportUrl: (jobId: string, file: string) => `/api/jobs/${enc(jobId)}/exports/${enc(file)}`,
  style: () => request<Style>('GET', '/api/style'),
  saveStyle: (patch: Partial<Style> & { preset?: string }) => request<Style>('PUT', '/api/style', patch),
  audit: (limit = 300) => request<AuditRecord[]>('GET', `/api/audit?limit=${limit}`),
  sessions: () => request<SessionSummary[]>('GET', '/api/sessions'),
  newSession: () => request<SessionView>('POST', '/api/sessions'),
  session: (id: string) => request<SessionView>('GET', `/api/sessions/${enc(id)}`),
  setActiveJob: (id: string, jobId: string) => request<{ activeJobId?: string }>('PATCH', `/api/sessions/${enc(id)}`, { activeJobId: jobId }),
};

/** Posts to a streaming endpoint and yields its server-sent events. */
export async function* stream(url: string, body?: unknown): AsyncGenerator<SseMessage> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  if (!res.headers.get('content-type')?.includes('text/event-stream') || !res.body) return;
  yield* readSse(res.body);
}
