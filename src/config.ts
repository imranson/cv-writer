import path from 'node:path';

export type AgentType = 'coordinator' | 'writer' | 'critic';

export interface Config {
  port: number;
  host: string;
  isProduction: boolean;
  /** Postgres connection string; when empty an embedded PGlite database is used. */
  databaseUrl: string;
  /** PGlite data dir (":memory:" for an in-memory DB). Only used without DATABASE_URL. */
  pgliteDir: string;
  ollamaHost: string;
  ollamaApiKey: string;
  models: Record<AgentType, string>;
  /** Fallback context window (tokens) when the model can't be queried. */
  contextWindow: number;
  maxSteps: Record<AgentType, number>;
  skillsDir: string;
  publicDir: string;
  cookieSecure: boolean;
}

function int(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProduction = env.NODE_ENV === 'production';
  const apiKey = env.OLLAMA_API_KEY ?? '';
  // With an API key we talk to Ollama's cloud API directly (Railway); otherwise use a local daemon
  // that is signed in to ollama.com (cloud models are proxied through it).
  const ollamaHost = (env.OLLAMA_HOST || (apiKey ? 'https://ollama.com' : 'http://127.0.0.1:11434')).replace(/\/+$/, '');
  const defaultModel = env.OLLAMA_MODEL || 'kimi-k2.6:cloud';
  return {
    port: int(env.PORT, 3000),
    host: env.HOST || '0.0.0.0',
    isProduction,
    databaseUrl: env.DATABASE_URL ?? '',
    pgliteDir: env.PGLITE_DIR || path.resolve('data/db'),
    ollamaHost,
    ollamaApiKey: apiKey,
    models: {
      coordinator: env.COORDINATOR_MODEL || defaultModel,
      writer: env.WRITER_MODEL || defaultModel,
      critic: env.CRITIC_MODEL || defaultModel,
    },
    contextWindow: int(env.CONTEXT_WINDOW, 131072),
    maxSteps: {
      coordinator: int(env.COORDINATOR_MAX_STEPS, 24),
      writer: int(env.WRITER_MAX_STEPS, 30),
      critic: int(env.CRITIC_MAX_STEPS, 12),
    },
    skillsDir: env.SKILLS_DIR || path.resolve('skills'),
    publicDir: env.PUBLIC_DIR || path.resolve('dist/public'),
    cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : isProduction,
  };
}
