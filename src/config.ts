import path from 'node:path';

export type ThinkSetting = boolean | 'low' | 'medium' | 'high';

export interface OllamaConfig {
  host: string;
  apiKey?: string;
  /** Model used by the coordinator (the agent the user talks to). */
  model: string;
  writerModel: string;
  criticModel: string;
  think?: ThinkSetting;
  /** Overrides the context length reported by the model (tokens). */
  contextLength?: number;
  temperature?: number;
}

export interface AppConfig {
  port: number;
  hostname: string;
  dataDir: string;
  /** Built-in (version-controlled) skills shipped with the app. */
  builtinSkillsDir: string;
  /** Static frontend build served by the API server. */
  webDir: string;
  ollama: OllamaConfig;
  /** Fraction of the context window at which the coordinator history is compacted. */
  compactThreshold: number;
  /** Hosts the PDF renderer may fetch from (e.g. web fonts). Everything else is blocked. */
  pdfAllowedHosts: string[];
}

export const DEFAULT_MODEL = 'kimi-k2.6:cloud';
const DIRECT_CLOUD_HOST = 'https://ollama.com';
const LOCAL_HOST = 'http://127.0.0.1:11434';

const projectRoot = path.resolve(import.meta.dirname, '..');

export function normaliseHost(host: string): string {
  const trimmed = host.trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
}

export function isDirectCloud(host: string): boolean {
  try {
    return new URL(normaliseHost(host)).hostname.endsWith('ollama.com');
  } catch {
    return false;
  }
}

/**
 * Cloud models are addressed as `name:cloud` / `name-cloud` through a local Ollama daemon,
 * but by their bare name when talking to https://ollama.com directly.
 */
export function resolveModelName(model: string, host: string): string {
  if (!isDirectCloud(host)) return model;
  return model.replace(/[:-]cloud$/, '');
}

export function parseThink(value: string | undefined): ThinkSetting | undefined {
  if (value === undefined || value === '') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'true' || v === '1' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'off') return false;
  if (v === 'low' || v === 'medium' || v === 'high') return v;
  throw new Error(`Invalid OLLAMA_THINK value "${value}" (expected true, false, low, medium or high)`);
}

function parsePositiveNumber(name: string, value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number, got "${value}"`);
  return n;
}

function parseTemperature(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 2) throw new Error(`OLLAMA_TEMPERATURE must be between 0 and 2, got "${value}"`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const apiKey = env.OLLAMA_API_KEY || undefined;
  const host = normaliseHost(env.OLLAMA_HOST || (apiKey ? DIRECT_CLOUD_HOST : LOCAL_HOST));
  const model = resolveModelName(env.OLLAMA_MODEL || DEFAULT_MODEL, host);
  const threshold = parsePositiveNumber('COMPACT_THRESHOLD', env.COMPACT_THRESHOLD) ?? 0.8;
  if (threshold >= 1) throw new Error('COMPACT_THRESHOLD must be below 1');

  return {
    port: parsePositiveNumber('PORT', env.PORT) ?? 4317,
    hostname: env.BIND_ADDRESS || '127.0.0.1',
    dataDir: path.resolve(env.DATA_DIR || path.join(projectRoot, 'data')),
    builtinSkillsDir: path.resolve(env.BUILTIN_SKILLS_DIR || path.join(projectRoot, 'skills')),
    webDir: path.resolve(env.WEB_DIR || path.join(projectRoot, 'dist', 'web')),
    ollama: {
      host,
      apiKey,
      model,
      writerModel: env.WRITER_MODEL ? resolveModelName(env.WRITER_MODEL, host) : model,
      criticModel: env.CRITIC_MODEL ? resolveModelName(env.CRITIC_MODEL, host) : model,
      think: parseThink(env.OLLAMA_THINK),
      contextLength: parsePositiveNumber('CONTEXT_LENGTH', env.CONTEXT_LENGTH),
      temperature: parseTemperature(env.OLLAMA_TEMPERATURE),
    },
    compactThreshold: threshold,
    pdfAllowedHosts: (env.PDF_ALLOWED_HOSTS ?? 'fonts.googleapis.com,fonts.gstatic.com')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
  };
}
