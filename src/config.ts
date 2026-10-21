import path from 'node:path';

export type ThinkSetting = boolean | 'low' | 'medium' | 'high' | undefined;
export type AgentName = 'coordinator' | 'writer' | 'critic';

export interface Config {
  port: number;
  dataDir: string;
  skillsDir: string;
  publicDir: string;
  ollamaHost: string;
  ollamaApiKey?: string;
  models: Record<AgentName, string>;
  think: ThinkSetting;
  contextWindowOverride?: number;
  sessionSecret?: string;
}

export function parseThink(value: string | undefined): ThinkSetting {
  if (value === undefined || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  return undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const model = env.OLLAMA_MODEL || 'kimi-k2.6:cloud';
  const window = Number(env.CONTEXT_WINDOW);
  return {
    port: Number(env.PORT) || 4817,
    dataDir: path.resolve(env.DATA_DIR || './data'),
    skillsDir: path.resolve(env.SKILLS_DIR || './skills'),
    publicDir: path.resolve(env.PUBLIC_DIR || './public'),
    ollamaHost: env.OLLAMA_HOST || 'https://ollama.com',
    ollamaApiKey: env.OLLAMA_API_KEY || undefined,
    models: {
      coordinator: env.COORDINATOR_MODEL || model,
      writer: env.WRITER_MODEL || model,
      critic: env.CRITIC_MODEL || model,
    },
    think: parseThink(env.OLLAMA_THINK),
    contextWindowOverride: Number.isFinite(window) && window > 0 ? window : undefined,
    sessionSecret: env.SESSION_SECRET || undefined,
  };
}
