import type { AgentName, Config } from '../config.js';
import type { Repo } from '../db/repo.js';
import type { ChatMessage, LlmClient } from '../llm/types.js';
import type { WebClient } from '../lib/web.js';
import type { SkillLibrary } from '../skills/loader.js';
import type { Emit } from './events.js';
import { runAgent, type AgentSpec, type RunResult } from './loop.js';
import { buildSystemPrompt } from './prompts.js';
import type { AgentServices, PageCounter, SubagentInput, SubagentResult } from './tool.js';
import { AGENT_TOOLS, toolNames } from './tools/index.js';

export interface RuntimeDeps {
  config: Config;
  repo: Repo;
  llm: LlmClient;
  web: WebClient;
  skills: SkillLibrary;
  pages?: PageCounter;
  now?: () => Date;
}

export interface CoordinatorInput {
  userId: string;
  messages: ChatMessage[];
  task: string;
  emit: Emit;
  signal?: AbortSignal;
  timezone?: string;
}

export class AgentRuntime {
  readonly services: AgentServices;

  constructor(private readonly deps: RuntimeDeps) {
    this.services = {
      config: deps.config,
      repo: deps.repo,
      llm: deps.llm,
      web: deps.web,
      skills: deps.skills,
      pages: deps.pages,
      now: deps.now ?? (() => new Date()),
      runSubagent: (agent, input) => this.runSubagent(agent, input),
    };
  }

  async contextWindow(agent: AgentName): Promise<number> {
    const cfg = this.deps.config.agents[agent];
    if (cfg.contextWindow) return cfg.contextWindow;
    const detected = await this.deps.llm.contextWindow?.(cfg.model).catch(() => undefined);
    return detected ?? this.deps.config.defaultContextWindow;
  }

  async spec(agent: AgentName): Promise<AgentSpec> {
    const cfg = this.deps.config.agents[agent];
    return {
      agent,
      model: cfg.model,
      systemPrompt: buildSystemPrompt(agent, this.deps.skills.catalog(agent), toolNames(agent)),
      tools: AGENT_TOOLS[agent],
      maxSteps: cfg.maxSteps,
      contextWindow: await this.contextWindow(agent),
    };
  }

  async runCoordinator(input: CoordinatorInput): Promise<RunResult> {
    return runAgent({
      spec: await this.spec('coordinator'),
      messages: input.messages,
      task: input.task,
      userId: input.userId,
      services: this.services,
      emit: input.emit,
      signal: input.signal,
      timezone: input.timezone,
    });
  }

  async runSubagent(agent: 'writer' | 'critic', input: SubagentInput): Promise<SubagentResult> {
    const job = await this.deps.repo.getJob(input.userId, input.jobId);
    const label = job ? `${job.data.title ?? 'Untitled role'}${job.data.company ? ` at ${job.data.company}` : ''}` : 'unknown job';
    const content =
      agent === 'writer'
        ? `Task from the Coordinator:\n${input.task}\n\nAssigned job: ${label} (jobId ${input.jobId}). Tools default to this job when jobId is omitted.`
        : `${input.task}\n\nJob under review: ${label} (jobId ${input.jobId}). Tools default to this job when jobId is omitted.`;
    const res = await runAgent({
      spec: await this.spec(agent),
      messages: [{ role: 'user', content }],
      task: input.task,
      userId: input.userId,
      services: this.services,
      emit: input.emit,
      signal: input.signal,
      parentRunId: input.parentRunId,
      boundJobId: input.jobId,
      timezone: input.timezone,
    });
    return { ok: res.ok, result: res.final, runId: res.runId };
  }
}
