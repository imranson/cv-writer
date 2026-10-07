import path from 'node:path';
import { parseArgs } from 'node:util';
import { OLLAMA_CLOUD_HOST, OLLAMA_LOCAL_HOST } from './llm/ollama.js';
import type { Think } from './llm/types.js';

export const DEFAULT_MODELS = {
  coordinator: 'glm-5.3:cloud',
  writer: 'deepseek-v4-pro:cloud',
  critic: 'glm-5.3:cloud',
} as const;

export interface AppConfig {
  dataDir: string;
  port: number;
  /** Interface to listen on; local only by default, since the app has no login. */
  listen: string;
  ollamaHost: string;
  /** Needed only when calling https://ollama.com directly. Read from the environment, never from flags. */
  apiKey?: string;
  models: { coordinator: string; writer: string; critic: string };
  think?: Think;
  chromePath?: string;
}

export const USAGE = `Usage: npm start -- [options]

  --port <n>              HTTP port (default 5174, env PORT)
  --data <dir>            where profile, jobs, CVs, runs and exports are stored (default ./data, env CV_WRITER_DATA_DIR)
  --model <name>          coordinator model (default ${DEFAULT_MODELS.coordinator}, env CV_WRITER_MODEL)
  --writer-model <name>   CV writer model (default ${DEFAULT_MODELS.writer}, env CV_WRITER_WRITER_MODEL)
  --critic-model <name>   CV critic model (default ${DEFAULT_MODELS.critic}, env CV_WRITER_CRITIC_MODEL)
  --think <level>         reasoning: off, on, low, medium, high (env CV_WRITER_THINK; default: model's own)
  --ollama-host <url>     Ollama server (env OLLAMA_HOST; default ${OLLAMA_LOCAL_HOST}, or ${OLLAMA_CLOUD_HOST} when OLLAMA_API_KEY is set)
  -h, --help              show this help

Cloud models run through a local Ollama signed in with \`ollama signin\`, or directly
against ${OLLAMA_CLOUD_HOST} with OLLAMA_API_KEY set. PDF export uses a local Chrome/Chromium
(or CHROME_PATH).`;

const THINK: Record<string, Think> = { off: false, false: false, on: true, true: true, low: 'low', medium: 'medium', high: 'high' };

export function parseThink(value: string): Think {
  const think = THINK[value.trim().toLowerCase()];
  if (think === undefined) throw new Error(`Invalid think level "${value}"; use off, on, low, medium or high`);
  return think;
}

/** OLLAMA_HOST may be "0.0.0.0:11434" or "localhost" (as the Ollama CLI accepts); make it a URL. */
export function normaliseHost(host: string): string {
  let h = host.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(h)) h = `http://${h}`;
  const url = new URL(h);
  if (url.hostname === '0.0.0.0') url.hostname = '127.0.0.1';
  if (!url.port && url.protocol === 'http:' && !/ollama\.com$/i.test(url.hostname)) url.port = '11434';
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      port: { type: 'string' },
      data: { type: 'string' },
      model: { type: 'string' },
      'writer-model': { type: 'string' },
      'critic-model': { type: 'string' },
      think: { type: 'string' },
      'ollama-host': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return 'help';
  const port = Number(values.port ?? env.PORT ?? 5174);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port "${values.port ?? env.PORT}"`);
  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  const think = values.think ?? env.CV_WRITER_THINK;
  const host = values['ollama-host'] ?? env.OLLAMA_HOST;
  return {
    dataDir: path.resolve(cwd, values.data ?? env.CV_WRITER_DATA_DIR ?? 'data'),
    port,
    listen: env.CV_WRITER_LISTEN ?? '127.0.0.1',
    ollamaHost: host ? normaliseHost(host) : apiKey ? OLLAMA_CLOUD_HOST : OLLAMA_LOCAL_HOST,
    models: {
      coordinator: values.model ?? env.CV_WRITER_MODEL ?? DEFAULT_MODELS.coordinator,
      writer: values['writer-model'] ?? env.CV_WRITER_WRITER_MODEL ?? DEFAULT_MODELS.writer,
      critic: values['critic-model'] ?? env.CV_WRITER_CRITIC_MODEL ?? DEFAULT_MODELS.critic,
    },
    ...(apiKey ? { apiKey } : {}),
    ...(think ? { think: parseThink(think) } : {}),
    ...(env.CHROME_PATH ? { chromePath: env.CHROME_PATH } : {}),
  };
}
