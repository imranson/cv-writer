import type { Message } from 'ollama';
import type { AgentName } from '../config';

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: string;
}

export type PublicUser = Omit<User, 'passwordHash'>;

export type Profile = Record<string, unknown>;

export interface Job {
  id: string;
  title: string;
  company: string;
  location?: string;
  url?: string;
  description?: string;
  notes?: string;
  status?: string;
  createdAt: string;
  updatedAt: string;
  [extra: string]: unknown;
}

export type JobSummary = Pick<Job, 'id' | 'title' | 'company' | 'status' | 'updatedAt'>;

export interface CvPreferences {
  pageSize: 'A4' | 'Letter';
  maxPages: number;
  tone: string;
  language: string;
  sectionOrder: string[];
  emphasis: string[];
  exclude: string[];
  notes: string;
  [extra: string]: unknown;
}

export interface ContextUsage {
  /** Tokens in the most recent prompt + completion. */
  used: number;
  window: number;
  promptTokens: number;
  outputTokens: number;
  estimated: boolean;
  updatedAt: string;
}

/** Activity log entries persisted with a session so the UI can replay tool use. */
export type ActivityEvent =
  | { type: 'user_message'; at: string; content: string }
  | { type: 'agent_start'; at: string; runId: string; parentRunId?: string; agent: AgentName; task?: string }
  | { type: 'assistant_message'; at: string; runId: string; agent: AgentName; content: string; thinking?: string }
  | { type: 'tool_call'; at: string; runId: string; agent: AgentName; callId: string; name: string; args: unknown }
  | {
      type: 'tool_result';
      at: string;
      runId: string;
      agent: AgentName;
      callId: string;
      name: string;
      ok: boolean;
      result: string;
      durationMs: number;
    }
  | { type: 'usage'; at: string; runId: string; agent: AgentName; usage: ContextUsage }
  | { type: 'agent_end'; at: string; runId: string; agent: AgentName; result: string; error?: string }
  | { type: 'data_changed'; at: string; kind: DataKind; jobId?: string }
  | { type: 'error'; at: string; message: string };

export type DataKind = 'profile' | 'job' | 'cv' | 'css' | 'preferences';

export interface ChatSession {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Coordinator conversation history as sent to the model. */
  messages: Message[];
  events: ActivityEvent[];
  usage: Partial<Record<AgentName, ContextUsage>>;
}

export type SessionSummary = Pick<ChatSession, 'id' | 'title' | 'createdAt' | 'updatedAt'>;

export const DEFAULT_PROFILE: Profile = {
  name: '',
  headline: '',
  contact: { email: '', phone: '', location: '', links: [] },
  summary: '',
  experience: [],
  education: [],
  skills: [],
  certifications: [],
  projects: [],
  languages: [],
  achievements: [],
  interests: [],
  notes: [],
};

export const DEFAULT_PREFERENCES: CvPreferences = {
  pageSize: 'A4',
  maxPages: 2,
  tone: 'professional',
  language: 'en-GB',
  sectionOrder: ['header', 'summary', 'experience', 'skills', 'education', 'projects', 'certifications'],
  emphasis: [],
  exclude: [],
  notes: '',
};

export const DEFAULT_CV_HTML = `<header class="cv-header">
  <h1>Your Name</h1>
  <p class="headline">Your CV will appear here once the writer drafts it.</p>
</header>
`;

export const DEFAULT_CSS = `@page { size: A4; margin: 14mm 16mm; }
:root { --ink: #1d232a; --muted: #5b6672; --accent: #1f5f8b; --rule: #d6dde4; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10.5pt; line-height: 1.4; color: var(--ink); margin: 0; }
h1 { font-size: 22pt; margin: 0 0 2pt; letter-spacing: -0.01em; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.08em; color: var(--accent);
     border-bottom: 1px solid var(--rule); padding-bottom: 2pt; margin: 12pt 0 6pt; }
h3 { font-size: 10.5pt; margin: 0; }
p { margin: 0 0 4pt; }
ul { margin: 2pt 0 6pt; padding-left: 14pt; }
li { margin-bottom: 2pt; }
a { color: var(--accent); text-decoration: none; }
.cv-header { margin-bottom: 6pt; }
.headline { color: var(--muted); font-size: 11.5pt; }
.contact { color: var(--muted); font-size: 9.5pt; }
.role { break-inside: avoid; margin-bottom: 8pt; }
.role-meta { display: flex; justify-content: space-between; color: var(--muted); font-size: 9.5pt; }
.skills { display: flex; flex-wrap: wrap; gap: 3pt 10pt; padding: 0; list-style: none; }
`;
