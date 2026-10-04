import type { HookInput, McpSdkServerConfigWithInstance, Options, SyncHookJSONOutput } from '@anthropic-ai/claude-agent-sdk';
import { connectMcp } from './mcp.js';

export interface SimCaller {
  agentId?: string;
  agentType?: string;
}

export interface SimCallResult {
  denied?: string;
  isError?: boolean;
  text?: string;
  json?: <T = any>() => T;
}

/**
 * Executes tool calls the way the Agent SDK would for the given options: subagents only
 * see their definition's tools, PreToolUse hooks run first, and app tools go through the
 * real in-process MCP server.
 */
export async function simulatedRuntime(options: Options) {
  const mcp = await connectMcp(options.mcpServers!.cv as McpSdkServerConfigWithInstance);
  const hooks = (options.hooks?.PreToolUse ?? []).flatMap((m) => m.hooks);
  let seq = 0;

  async function callTool(name: string, input: Record<string, unknown>, caller: SimCaller = {}): Promise<SimCallResult> {
    if (caller.agentType && !options.agents?.[caller.agentType]?.tools?.includes(name)) {
      return { denied: `No such tool available: ${name}` };
    }
    const toolUseId = `tu${++seq}`;
    for (const hook of hooks) {
      const hookInput = {
        hook_event_name: 'PreToolUse',
        session_id: 'sim',
        transcript_path: '/dev/null',
        cwd: '/',
        tool_name: name,
        tool_input: input,
        tool_use_id: toolUseId,
        ...(caller.agentId ? { agent_id: caller.agentId } : {}),
        ...(caller.agentType ? { agent_type: caller.agentType } : {}),
      } as HookInput;
      const out = (await hook(hookInput, toolUseId, { signal: new AbortController().signal })) as SyncHookJSONOutput;
      const specific = out.hookSpecificOutput as { permissionDecision?: string; permissionDecisionReason?: string } | undefined;
      if (specific?.permissionDecision === 'deny') return { denied: specific.permissionDecisionReason ?? 'denied' };
    }
    if (!name.startsWith('mcp__cv__')) return {};
    return mcp.call(name.slice('mcp__cv__'.length), input);
  }

  return { callTool, close: mcp.close };
}
