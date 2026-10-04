import path from 'node:path';
import { parseArgs } from 'node:util';
import { OLLAMA_CLOUD_HOST, OLLAMA_LOCAL_HOST } from './llm/ollama.js';
import type { Think } from './llm/types.js';

export const DEFAULT_MODEL = 'glm-5.3:cloud';
export const DEFAULT_WRITER_MODEL = 'deepseek-v4-pro:cloud';

export interface AppConfig {
  dataDir: string;
  /** Ollama server: a local daemon (signed in for cloud models) or https://ollama.com. */
  host: string;
  /** Needed only when calling https://ollama.com directly. Read from the environment, never from flags. */
  apiKey?: string;
  /** Model for the coordinator (the agent the user talks to). */
  model: string;
  /** Model for the cv-writer agent. */
  writerModel: string;
  think?: Think;
  /** A saved session id to continue, or 'latest'. */
  resume?: string;
}

export const USAGE = `Usage: npm start -- [options]

  --model <name>         coordinator model (default: ${DEFAULT_MODEL}, env CV_WRITER_MODEL)
  --writer-model <name>  cv-writer model (default: ${DEFAULT_WRITER_MODEL}, env CV_WRITER_WRITER_MODEL)
  --host <url>           Ollama server (env OLLAMA_HOST; default: ${OLLAMA_LOCAL_HOST},
                         or ${OLLAMA_CLOUD_HOST} when OLLAMA_API_KEY is set)
  --think <level>        reasoning: off, on, low, medium or high (env CV_WRITER_THINK; default: model's own)
  --data <dir>           where profile, jobs, CV versions and exports are stored (default: ./data)
  --resume <id>          continue a saved conversation
  -c, --continue         continue the most recent conversation
  -h, --help             show this help

Cloud models run through a local Ollama signed in with \`ollama signin\`, or directly
against ${OLLAMA_CLOUD_HOST} with OLLAMA_API_KEY set.`;

const THINK: Record<string, Think> = { off: false, false: false, on: true, true: true, low: 'low', medium: 'medium', high: 'high' };

export function parseThink(value: string): Think {
  const think = THINK[value.trim().toLowerCase()];
  if (think === undefined) throw new Error(`Invalid --think "${value}"; use off, on, low, medium or high`);
  return think;
}

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      host: { type: 'string' },
      model: { type: 'string' },
      'writer-model': { type: 'string' },
      think: { type: 'string' },
      resume: { type: 'string' },
      continue: { type: 'boolean', short: 'c' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return 'help';
  if (values.resume && values.continue) throw new Error('Use either --resume <id> or --continue, not both');

  const apiKey = env.OLLAMA_API_KEY?.trim() || undefined;
  const think = values.think ?? env.CV_WRITER_THINK;
  const resume = values.resume ?? (values.continue ? 'latest' : undefined);
  return {
    dataDir: path.resolve(cwd, values.data ?? env.CV_WRITER_DATA_DIR ?? 'data'),
    host: values.host ?? env.OLLAMA_HOST ?? (apiKey ? OLLAMA_CLOUD_HOST : OLLAMA_LOCAL_HOST),
    model: values.model ?? env.CV_WRITER_MODEL ?? DEFAULT_MODEL,
    writerModel: values['writer-model'] ?? env.CV_WRITER_WRITER_MODEL ?? DEFAULT_WRITER_MODEL,
    ...(apiKey ? { apiKey } : {}),
    ...(think ? { think: parseThink(think) } : {}),
    ...(resume ? { resume } : {}),
  };
}
