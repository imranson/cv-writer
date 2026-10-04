import type { HookInput } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { checkToolAccess, createPolicyHook, toolOwners } from '../../src/agents/policy.js';
import { createCvTools } from '../../src/agents/tools.js';
import { tempStore } from '../helpers.js';

const store = await tempStore();
const owners = toolOwners(createCvTools(store));
const main = {};
const writer = { agentId: 'a1', agentType: 'cv-writer' };
const other = { agentId: 'a2', agentType: 'general-purpose' };

describe('checkToolAccess', () => {
  it.each([
    // [tool, caller, allowed]
    ['mcp__cv__get_profile', main, true],
    ['mcp__cv__get_profile', writer, true],
    ['mcp__cv__get_cv_version', writer, true],
    ['mcp__cv__upsert_profile_entry', main, true],
    ['mcp__cv__upsert_profile_entry', writer, false],
    ['mcp__cv__approve_cv', main, true],
    ['mcp__cv__approve_cv', writer, false],
    ['mcp__cv__save_job_listing', writer, false],
    ['mcp__cv__save_cv_version', writer, true],
    ['mcp__cv__save_cv_version', main, false],
    ['mcp__cv__save_cv_version', other, false],
    ['WebFetch', main, true],
  ] as const)('%s from %o → allowed=%s', (tool, caller, allowed) => {
    expect(checkToolAccess(tool, {}, caller, owners).allowed).toBe(allowed);
  });

  it('lets the coordinator start only the cv-writer agent', () => {
    expect(checkToolAccess('Agent', { subagent_type: 'cv-writer' }, main, owners)).toEqual({ allowed: true });
    expect(checkToolAccess('Agent', { subagent_type: 'general-purpose' }, main, owners)).toMatchObject({ allowed: false });
    expect(checkToolAccess('Agent', {}, main, owners)).toMatchObject({ allowed: false });
    expect(checkToolAccess('Task', { subagent_type: 'Explore' }, main, owners)).toMatchObject({ allowed: false });
  });

  it('stops subagents from starting agents', () => {
    expect(checkToolAccess('Agent', { subagent_type: 'cv-writer' }, writer, owners)).toMatchObject({ allowed: false });
  });

  it('explains denials so the model can recover', () => {
    const decision = checkToolAccess('mcp__cv__save_cv_version', {}, main, owners);
    expect(decision).toEqual({ allowed: false, reason: expect.stringMatching(/Delegate the CV/) });
  });
});

describe('createPolicyHook', () => {
  const input = (tool_name: string, extra: Record<string, unknown> = {}) =>
    ({
      hook_event_name: 'PreToolUse',
      session_id: 's',
      transcript_path: '/t',
      cwd: '/',
      tool_name,
      tool_input: { jobId: 'x' },
      tool_use_id: 'tu1',
      ...extra,
    }) as HookInput;

  it('allows permitted calls without an opinion', async () => {
    const hook = createPolicyHook(store, owners);
    expect(await hook(input('mcp__cv__get_profile'), 'tu1', { signal: new AbortController().signal })).toEqual({});
  });

  it('denies forbidden calls and audits them', async () => {
    const s = await tempStore();
    const hook = createPolicyHook(s, owners);
    const out = await hook(
      input('mcp__cv__approve_cv', { agent_id: 'a1', agent_type: 'cv-writer' }),
      'tu1',
      { signal: new AbortController().signal },
    );
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: expect.stringContaining('reserved for the coordinator'),
      },
    });
    expect(await s.readAudit()).toEqual([
      expect.objectContaining({ actor: 'cv-writer', action: 'mcp__cv__approve_cv', ok: false }),
    ]);
  });

  it('ignores other hook events', async () => {
    const hook = createPolicyHook(store, owners);
    const stop = { hook_event_name: 'Stop', session_id: 's', transcript_path: '/t', cwd: '/' } as HookInput;
    expect(await hook(stop, undefined, { signal: new AbortController().signal })).toEqual({});
  });
});
