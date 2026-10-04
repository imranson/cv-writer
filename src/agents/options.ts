import type { AgentDefinition, Options } from '@anthropic-ai/claude-agent-sdk';
import type { AppConfig } from '../config.js';
import type { CvStore } from '../storage/store.js';
import { AGENT_TOOL, createPolicyHook, toolOwners } from './policy.js';
import { COORDINATOR_PROMPT, CV_WRITER_AGENT, CV_WRITER_PROMPT } from './prompts.js';
import { createCvMcpServer, MCP_SERVER_NAME, mcpToolName, type CvTool } from './tools.js';

/** Built-in Claude Code tools the coordinator keeps; everything else (Bash, file edits, ...) is off. */
export const BUILTIN_TOOLS = [AGENT_TOOL, 'WebFetch'];

export function cvWriterAgent(tools: CvTool[], model: string): AgentDefinition {
  return {
    description:
      'Writes and revises tailored CVs. Give it the job id; for a revision also the version to revise and the user feedback verbatim. It saves the CV itself and reports the version number.',
    prompt: CV_WRITER_PROMPT,
    tools: tools.filter((t) => t.owner !== 'coordinator').map((t) => mcpToolName(t.definition.name)),
    model,
    effort: 'high',
    maxTurns: 25,
    omitClaudeMd: true,
  };
}

export function buildAgentOptions(params: {
  config: AppConfig;
  store: CvStore;
  tools: CvTool[];
  env?: NodeJS.ProcessEnv;
}): Options {
  const { config, store, tools, env = process.env } = params;
  return {
    model: config.model,
    systemPrompt: COORDINATOR_PROMPT,
    tools: BUILTIN_TOOLS,
    mcpServers: { [MCP_SERVER_NAME]: createCvMcpServer(tools) },
    allowedTools: [...BUILTIN_TOOLS, ...tools.map((t) => mcpToolName(t.definition.name))],
    // Anything not allowed above is denied rather than prompting: the user is not a developer.
    permissionMode: 'dontAsk',
    agents: { [CV_WRITER_AGENT]: cvWriterAgent(tools, config.writerModel) },
    hooks: { PreToolUse: [{ hooks: [createPolicyHook(store, toolOwners(tools))] }] },
    // Isolate from the developer's own Claude Code setup: no settings or CLAUDE.md files,
    // no configured MCP servers and no claude.ai connectors — only this app's tools.
    settingSources: [],
    strictMcpConfig: true,
    settings: { disableClaudeAiConnectors: true },
    thinking: { type: 'adaptive' },
    effort: 'medium',
    env: {
      ...env,
      CLAUDE_AGENT_SDK_CLIENT_APP: 'cv-writer/1.0.0',
      // Subagents default to running in the background; the coordinator must wait for each draft.
      CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
    },
    ...(config.resume ? { resume: config.resume } : {}),
    ...(config.maxBudgetUsd ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
  };
}
