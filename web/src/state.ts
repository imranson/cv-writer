import type { AppInfo, ArtifactKind, JobSummary, Session, SessionSummary } from './types.ts';

export interface AppState {
  info: AppInfo | null;
  sessions: SessionSummary[];
  jobs: JobSummary[];
  session: Session | null;
  running: boolean;
}

export const state: AppState = {
  info: null,
  sessions: [],
  jobs: [],
  session: null,
  running: false,
};

export interface Topics {
  sessions: void;
  jobs: void;
  /** The open session changed (switched, or its job/title changed). */
  session: void;
  running: boolean;
  artifact: { kind: ArtifactKind; jobId?: string };
  /** Pre-fill or send a chat message from elsewhere in the UI. */
  compose: { text: string; send?: boolean };
  /** Show a workspace tab. */
  tab: string;
}

type Handler<T> = (payload: T) => void;
const handlers = new Map<keyof Topics, Set<Handler<never>>>();

export const bus = {
  on<K extends keyof Topics>(topic: K, fn: Handler<Topics[K]>): () => void {
    if (!handlers.has(topic)) handlers.set(topic, new Set());
    handlers.get(topic)!.add(fn as Handler<never>);
    return () => handlers.get(topic)?.delete(fn as Handler<never>);
  },
  emit<K extends keyof Topics>(topic: K, ...payload: Topics[K] extends void ? [] : [Topics[K]]): void {
    for (const fn of handlers.get(topic) ?? []) (fn as Handler<Topics[K]>)(payload[0] as Topics[K]);
  },
};

export function activeJobId(): string | null {
  return state.session?.jobId ?? null;
}

export function jobById(id: string | null | undefined): JobSummary | undefined {
  return id ? state.jobs.find((j) => j.id === id) : undefined;
}
