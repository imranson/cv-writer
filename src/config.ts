import path from 'node:path';

export const AGENT_NAMES = ['coordinator', 'writer', 'critic'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export interface AgentConfig {
  model: string;
  /** Explicit context window override (tokens). Detected from the model when absent. */
  contextWindow?: number;
  /** Maximum LLM round-trips per run before the loop is stopped. */
  maxSteps: number;
}

export interface Config {
  port: number;
  host: string;
  production: boolean;
  databaseUrl?: string;
  pgliteDir?: string;
  ollama: { host: string; apiKey?: string };
  agents: Record<AgentName, AgentConfig>;
  defaultContextWindow: number;
  skillsDir: string;
  publicDir: string;
  sessionTtlDays: number;
  allowRegistration: boolean;
}

type Env = Record<string, string | undefined>;

function int(env: Env, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

function optionalInt(env: Env, key: string): number | undefined {
  return env[key] && env[key]!.trim() !== '' ? int(env, key, 0) : undefined;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

const DEFAULT_MODEL = 'kimi-k2.6:cloud';
const DEFAULT_STEPS: Record<AgentName, number> = { coordinator: 24, writer: 30, critic: 12 };

export function loadConfig(env: Env = process.env, cwd = process.cwd()): Config {
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  const ollamaHost = (env.OLLAMA_HOST?.trim() || (apiKey ? 'https://ollama.com' : 'http://localhost:11434')).replace(/\/+$/, '');
  const databaseUrl = env.DATABASE_URL?.trim() || undefined;

  const agents = {} as Record<AgentName, AgentConfig>;
  for (const name of AGENT_NAMES) {
    const key = name.toUpperCase();
    agents[name] = {
      model: env[`${key}_MODEL`]?.trim() || env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL,
      contextWindow: optionalInt(env, `${key}_CONTEXT_WINDOW`),
      maxSteps: int(env, `${key}_MAX_STEPS`, DEFAULT_STEPS[name]),
    };
  }

  return {
    port: int(env, 'PORT', 3000),
    host: env.HOST?.trim() || '0.0.0.0',
    production: env.NODE_ENV === 'production',
    databaseUrl,
    pgliteDir: databaseUrl ? undefined : path.resolve(cwd, env.PGLITE_DIR?.trim() || 'data/pglite'),
    ollama: { host: ollamaHost, apiKey },
    agents,
    defaultContextWindow: int(env, 'DEFAULT_CONTEXT_WINDOW', 131072),
    skillsDir: path.resolve(cwd, env.SKILLS_DIR?.trim() || 'skills'),
    publicDir: path.resolve(cwd, env.PUBLIC_DIR?.trim() || 'public'),
    sessionTtlDays: int(env, 'SESSION_TTL_DAYS', 30),
    allowRegistration: bool(env, 'ALLOW_REGISTRATION', true),
  };
}
