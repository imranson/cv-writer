// Client-side mirrors of the API's JSON shapes.

export type AgentName = 'coordinator' | 'writer' | 'critic';

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface Message {
  id: string;
  at: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCall[];
  toolName?: string;
}

export interface ContextUsage {
  tokens: number;
  limit: number;
  estimated: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  context: ContextUsage;
}

export interface Session extends Omit<SessionSummary, 'messageCount'> {
  messages: Message[];
  contextStart: number;
  summary: string;
  running?: boolean;
}

export interface JobSummary {
  id: string;
  title: string;
  company: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
  hasCv: boolean;
  score?: number;
  verdict?: Verdict;
  critiqueStale?: boolean;
}

export interface Job {
  id: string;
  title: string;
  company: string;
  url?: string;
  listing: string;
  createdAt: string;
  updatedAt: string;
}

export type Verdict = 'ready' | 'needs_work' | 'not_ready';

export interface CheckFinding {
  id: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
}

export interface Critique {
  summary: string;
  scores: Record<'relevance' | 'impact' | 'clarity' | 'structure' | 'accuracy', number>;
  coverage: { requirement: string; status: 'met' | 'partial' | 'missing'; evidence?: string; suggestion?: string }[];
  mistakes: { severity: 'critical' | 'major' | 'minor'; kind: string; location: string; issue: string; fix: string }[];
  factualIssues: { claim: string; problem: string; detail: string }[];
  strengths: string[];
  improvements: string[];
  questionsForCandidate: string[];
  score: number;
  verdict: Verdict;
  checks: CheckFinding[];
  createdAt: string;
  cvHash: string;
  focus?: string;
}

export interface CvVersion {
  id: string;
  createdAt: string;
  source: string;
  bytes: number;
}

export interface StylePreset {
  id: string;
  name: string;
  description: string;
  css: string;
}

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  audience: AgentName[];
  tags: string[];
  autoload: boolean;
  source: 'builtin' | 'user';
  overridesBuiltin?: boolean;
}

export interface Skill extends SkillMeta {
  body: string;
}

export interface AppInfo {
  models: Record<AgentName, string>;
  host?: string;
  contextLength: number;
  pdf: boolean;
}

export type ArtifactKind = 'profile' | 'job' | 'cv' | 'style' | 'critique' | 'skill' | 'session';

export type ServerEvent =
  | { type: 'text'; agent: AgentName; delta: string }
  | { type: 'thinking'; agent: AgentName; delta: string }
  | { type: 'tool_start'; agent: AgentName; callId: string; name: string; args: Record<string, unknown> }
  | { type: 'tool_end'; agent: AgentName; callId: string; name: string; ok: boolean; preview: string }
  | { type: 'usage'; agent: AgentName; promptTokens: number; completionTokens: number }
  | { type: 'artifact'; kind: ArtifactKind; jobId?: string }
  | { type: 'message'; message: Message }
  | { type: 'context'; context: ContextUsage }
  | { type: 'compacted'; compacted: number }
  | { type: 'session'; session: { id: string; title: string; jobId: string | null } }
  | { type: 'done'; stoppedBy: string }
  | { type: 'stopped' }
  | { type: 'error'; message: string };
