import path from 'node:path';
import { parseArgs } from 'node:util';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AppConfig {
  dataDir: string;
  /** Model for the coordinator (the agent the user talks to). */
  model: string;
  /** Model for the cv-writer subagent. */
  writerModel: string;
  /** Agent SDK session id to continue a previous conversation. */
  resume?: string;
  /** Hard spend cap for the whole session, in USD. */
  maxBudgetUsd?: number;
}

export const USAGE = `Usage: npm start -- [options]

  --data <dir>         where profile, jobs, CV versions and exports are stored (default: ./data)
  --model <id>         coordinator model (default: ${DEFAULT_MODEL}, env CV_WRITER_MODEL)
  --writer-model <id>  cv-writer model (default: same as --model, env CV_WRITER_WRITER_MODEL)
  --resume <id>        continue a previous conversation by session id
  --budget <usd>       stop the session once it has spent this much
  -h, --help           show this help`;

export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): AppConfig | 'help' {
  const { values } = parseArgs({
    args: argv,
    options: {
      data: { type: 'string' },
      model: { type: 'string' },
      'writer-model': { type: 'string' },
      resume: { type: 'string' },
      budget: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
    strict: true,
  });
  if (values.help) return 'help';

  const model = values.model ?? env.CV_WRITER_MODEL ?? DEFAULT_MODEL;
  const budget = values.budget ?? env.CV_WRITER_BUDGET_USD;
  const maxBudgetUsd = budget === undefined ? undefined : Number(budget);
  if (maxBudgetUsd !== undefined && !(maxBudgetUsd > 0)) throw new Error(`Invalid budget "${budget}"`);

  return {
    dataDir: path.resolve(cwd, values.data ?? env.CV_WRITER_DATA_DIR ?? 'data'),
    model,
    writerModel: values['writer-model'] ?? env.CV_WRITER_WRITER_MODEL ?? model,
    ...(values.resume ? { resume: values.resume } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
  };
}
