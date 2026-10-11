import { existsSync } from 'node:fs';
import path from 'node:path';

export type AgentName = 'coordinator' | 'writer' | 'critic';
export type ThinkSetting = boolean | 'low' | 'medium' | 'high';

export interface Config {
  port: number;
  dataDir: string;
  skillsDir: string;
  ollamaHost: string;
  ollamaApiKey?: string;
  models: Record<AgentName, string>;
  /** Explicit context window override in tokens; otherwise detected from the model. */
  contextWindow?: number;
  maxAgentSteps: number;
  /** Reasoning ("thinking") setting sent to the model; unset = model default. */
  think?: ThinkSetting;
}

const DEFAULT_MODEL = 'kimi-k2.6:cloud';
const LOCAL_HOST = 'http://127.0.0.1:11434';

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${value}"`);
  return n;
}

function thinkSetting(value: string | undefined): ThinkSetting | undefined {
  const v = value?.trim().toLowerCase();
  if (!v) return undefined;
  if (v === 'true' || v === 'false') return v === 'true';
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  throw new Error(`OLLAMA_THINK must be true, false, low, medium or high, got "${value}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): Config {
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  const model = env.OLLAMA_MODEL?.trim() || DEFAULT_MODEL;
  return {
    port: positiveInt(env.PORT, 'PORT') ?? 3000,
    dataDir: path.resolve(cwd, env.DATA_DIR || 'data'),
    skillsDir: path.resolve(cwd, env.SKILLS_DIR || 'skills'),
    ollamaHost: env.OLLAMA_HOST?.trim() || LOCAL_HOST,
    ollamaApiKey: apiKey,
    models: {
      coordinator: env.COORDINATOR_MODEL?.trim() || model,
      writer: env.WRITER_MODEL?.trim() || model,
      critic: env.CRITIC_MODEL?.trim() || model,
    },
    contextWindow: positiveInt(env.CONTEXT_WINDOW, 'CONTEXT_WINDOW'),
    maxAgentSteps: positiveInt(env.MAX_AGENT_STEPS, 'MAX_AGENT_STEPS') ?? 30,
    think: thinkSetting(env.OLLAMA_THINK),
  };
}

/** Loads `.env` from cwd into process.env (existing variables win). */
export function loadDotEnv(cwd = process.cwd()): void {
  const file = path.join(cwd, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
