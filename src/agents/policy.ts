import type { HookCallback, PreToolUseHookInput } from '@anthropic-ai/claude-agent-sdk';
import type { CvStore } from '../storage/store.js';
import { CV_WRITER_AGENT } from './prompts.js';
import { mcpToolName, type CvTool, type ToolOwner } from './tools.js';

export const AGENT_TOOL = 'Agent';
/** The subagent tool, under its current and legacy names. */
const SUBAGENT_TOOLS = new Set([AGENT_TOOL, 'Task']);

export interface Caller {
  /** Set when the call comes from inside a subagent. */
  agentId?: string;
  agentType?: string;
}

export type AccessDecision = { allowed: true } | { allowed: false; reason: string };

export function toolOwners(tools: CvTool[]): Map<string, ToolOwner> {
  return new Map(tools.map((t) => [mcpToolName(t.definition.name), t.owner]));
}

/**
 * Role separation between the agents: the coordinator owns the conversation, the
 * profile and approval; only the cv-writer subagent may save CV versions; and the
 * coordinator may delegate to the cv-writer and nothing else.
 */
export function checkToolAccess(
  toolName: string,
  toolInput: unknown,
  caller: Caller,
  owners: Map<string, ToolOwner>,
): AccessDecision {
  const inSubagent = caller.agentId !== undefined;

  if (SUBAGENT_TOOLS.has(toolName)) {
    if (inSubagent) return { allowed: false, reason: 'Subagents cannot start other agents.' };
    const type = (toolInput as { subagent_type?: unknown } | null)?.subagent_type;
    return type === CV_WRITER_AGENT
      ? { allowed: true }
      : { allowed: false, reason: `Only the "${CV_WRITER_AGENT}" agent is available; set subagent_type to "${CV_WRITER_AGENT}".` };
  }

  const owner = owners.get(toolName);
  if (owner === undefined || owner === 'shared') return { allowed: true };

  if (owner === 'coordinator') {
    return inSubagent
      ? { allowed: false, reason: `${toolName} is reserved for the coordinator. Report what is needed in your final reply instead.` }
      : { allowed: true };
  }

  return inSubagent && caller.agentType === owner
    ? { allowed: true }
    : { allowed: false, reason: `Only the ${owner} agent may call ${toolName}. Delegate the CV to it with the Agent tool.` };
}

export function createPolicyHook(store: CvStore, owners: Map<string, ToolOwner>): HookCallback {
  return async (input) => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    const { tool_name, tool_input, agent_id, agent_type } = input as PreToolUseHookInput;
    const decision = checkToolAccess(
      tool_name,
      tool_input,
      { ...(agent_id ? { agentId: agent_id } : {}), ...(agent_type ? { agentType: agent_type } : {}) },
      owners,
    );
    if (decision.allowed) return {};

    await store.audit({
      actor: agent_type ?? 'coordinator',
      action: tool_name,
      ok: false,
      detail: { denied: decision.reason, input: tool_input },
    });
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: decision.reason,
      },
    };
  };
}
