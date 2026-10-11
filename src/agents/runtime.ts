import { z } from 'zod';
import type { AgentName, Config } from '../config.js';
import type { ChatMessage, LLM } from '../llm/types.js';
import { loadSkills } from '../skills/loader.js';
import { commonTools } from '../tools/common.js';
import { cvTools, jobTools, profileTools } from '../tools/data.js';
import { loadSkillTool } from '../tools/skills.js';
import { defineTool, type Tool, type ToolContext } from '../tools/tool.js';
import type { WebClient } from '../tools/webClient.js';
import type { Workspace } from '../storage/workspace.js';
import { DEFAULT_CONTEXT_WINDOW } from './context.js';
import type { Emit } from './events.js';
import { runAgent, type AgentResult, type AgentSpec } from './loop.js';
import { COORDINATOR_PROMPT, CRITIC_PROMPT, WRITER_PROMPT } from './prompts.js';

export interface RuntimeDeps {
  config: Pick<Config, 'models' | 'skillsDir' | 'contextWindow' | 'maxAgentSteps' | 'think'>;
  llm: LLM;
  workspace: Workspace;
  web: WebClient;
  now?: () => Date;
  timeZone?: string;
}

export interface RunAgentOptions {
  emit: Emit;
  depth?: number;
  signal?: AbortSignal;
  onMessage?: (message: ChatMessage) => Promise<void> | void;
}

const INSTRUCTIONS: Record<AgentName, string> = {
  coordinator: COORDINATOR_PROMPT,
  writer: WRITER_PROMPT,
  critic: CRITIC_PROMPT,
};

/** Wires the three agents, their tool sets and their skills together. */
export class AgentRuntime {
  private readonly toolSets: Record<AgentName, Tool[]>;

  constructor(private readonly deps: RuntimeDeps) {
    const ws = deps.workspace;
    const profile = profileTools(ws);
    const job = jobTools(ws);
    const cv = cvTools(ws);
    const common = [...commonTools(deps.web), loadSkillTool(deps.config.skillsDir)];
    const callWriter = this.callWriterTool();
    const callCritic = this.callCriticTool();

    this.toolSets = {
      coordinator: [
        profile.readProfile,
        profile.writeProfile,
        profile.editProfile,
        job.readJob,
        job.writeJob,
        job.editJob,
        job.searchJobs,
        callWriter,
        callCritic,
        ...common,
      ],
      writer: [cv.readCV, cv.writeCV, cv.editCV, cv.searchCVs, profile.readProfile, callCritic, ...common],
      critic: [cv.readCV, job.readJob, cv.searchCVs, job.searchJobs, ...common],
    };
  }

  tools(agent: AgentName): Tool[] {
    return this.toolSets[agent];
  }

  spec(agent: AgentName): AgentSpec {
    return {
      name: agent,
      model: this.deps.config.models[agent],
      instructions: INSTRUCTIONS[agent],
      tools: this.toolSets[agent],
      maxSteps: this.deps.config.maxAgentSteps,
      think: this.deps.config.think,
    };
  }

  async contextWindow(agent: AgentName): Promise<number> {
    return (
      this.deps.config.contextWindow ?? (await this.deps.llm.contextWindow(this.deps.config.models[agent])) ?? DEFAULT_CONTEXT_WINDOW
    );
  }

  async run(agent: AgentName, history: ChatMessage[], options: RunAgentOptions): Promise<AgentResult> {
    const depth = options.depth ?? 0;
    return runAgent(this.spec(agent), history, {
      llm: this.deps.llm,
      emit: options.emit,
      depth,
      signal: options.signal,
      onMessage: options.onMessage,
      skills: await loadSkills(this.deps.config.skillsDir, agent),
      contextWindow: await this.contextWindow(agent),
      now: this.deps.now,
      timeZone: this.deps.timeZone,
    });
  }

  /** Runs a subagent with a fresh history and returns its final report to the calling agent. */
  private async delegate(agent: AgentName, brief: string, ctx: ToolContext): Promise<string> {
    const depth = ctx.depth + 1;
    ctx.emit({ type: 'agent_start', agent, depth, task: brief.slice(0, 500) });
    let ok = false;
    try {
      const result = await this.run(agent, [{ role: 'user', content: brief }], { emit: ctx.emit, depth, signal: ctx.signal });
      ok = result.completed;
      return result.text.trim() || `[${agent} returned an empty report]`;
    } finally {
      ctx.emit({ type: 'agent_end', agent, depth, ok });
    }
  }

  private callWriterTool(): Tool {
    return defineTool({
      name: 'callWriter',
      description:
        'Delegate writing or editing the CV for one job to the Writer subagent. The Writer cannot see the conversation: give a ' +
        'complete brief (goals, preferences such as length/tone/spelling/emphasis, exact change requests, facts to stress or avoid). ' +
        'The job record is attached automatically. The Writer has the CV critiqued before reporting back. Returns its report.',
      schema: z.object({
        jobId: z.string().min(1).describe('Job whose CV to write or edit'),
        profileId: z.string().min(1).optional().describe("The user's profile id"),
        instructions: z.string().min(1).describe('Complete brief for the Writer'),
      }),
      run: async ({ jobId, profileId, instructions }, ctx) => {
        const job = await this.deps.workspace.getJob(jobId).catch(() => undefined);
        const owner = profileId ?? (typeof job?.profileId === 'string' ? job.profileId : undefined);
        const brief = [
          `Brief from the ${ctx.agent}:`,
          instructions,
          '',
          `Job id: ${jobId}`,
          `Profile id: ${owner ?? '(unknown: call readProfile without an id to list profiles)'}`,
          job ? `Job record:\n\`\`\`json\n${JSON.stringify(job, null, 2)}\n\`\`\`` : 'Job record: (not found in the job store)',
        ].join('\n');
        return { writerReport: await this.delegate('writer', brief, ctx) };
      },
    });
  }

  private callCriticTool(): Tool {
    return defineTool({
      name: 'callCritic',
      description:
        'Ask the Critic subagent for an independent, prioritised critique of the CV for one job (it reads the CV and the job itself). ' +
        'Returns its critique.',
      schema: z.object({
        jobId: z.string().min(1).describe('Job whose CV to critique'),
        focus: z.string().optional().describe('Optional focus, e.g. "check the summary" or "ATS keywords"'),
      }),
      run: async ({ jobId, focus }, ctx) => {
        const brief = [
          `Critique request from the ${ctx.agent}.`,
          `Job id: ${jobId}`,
          focus ? `Focus: ${focus}` : 'Focus: full review',
        ].join('\n');
        return { critique: await this.delegate('critic', brief, ctx) };
      },
    });
  }
}
