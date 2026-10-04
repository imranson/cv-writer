import { describe, expect, it } from 'vitest';
import { buildAgentOptions, BUILTIN_TOOLS } from '../../src/agents/options.js';
import { COORDINATOR_PROMPT, CV_WRITER_PROMPT } from '../../src/agents/prompts.js';
import { createCvTools } from '../../src/agents/tools.js';
import { tempStore } from '../helpers.js';

const store = await tempStore();
const tools = createCvTools(store);
const config = { dataDir: store.root, model: 'claude-opus-5-5', writerModel: 'claude-sonnet-5-5' };

describe('buildAgentOptions', () => {
  const options = buildAgentOptions({ config, store, tools, env: { PATH: '/bin', HOME: '/h' } });

  it('runs the coordinator on the configured model with its own prompt', () => {
    expect(options.model).toBe('claude-opus-5-5');
    expect(options.systemPrompt).toBe(COORDINATOR_PROMPT);
    expect(options.thinking).toEqual({ type: 'adaptive' });
  });

  it('defines the cv-writer subagent with only reading tools and save_cv_version', () => {
    const writer = options.agents?.['cv-writer'];
    expect(writer).toMatchObject({ prompt: CV_WRITER_PROMPT, model: 'claude-sonnet-5-5', effort: 'high' });
    expect([...writer!.tools!].sort()).toEqual([
      'mcp__cv__get_cv_version',
      'mcp__cv__get_job_listing',
      'mcp__cv__get_profile',
      'mcp__cv__list_cv_versions',
      'mcp__cv__list_job_listings',
      'mcp__cv__save_cv_version',
    ]);
  });

  it('exposes only the app tools and pre-approves every one of them', () => {
    expect(options.tools).toEqual(BUILTIN_TOOLS);
    expect(Object.keys(options.mcpServers!)).toEqual(['cv']);
    expect(options.allowedTools).toHaveLength(BUILTIN_TOOLS.length + tools.length);
    expect(options.allowedTools).toContain('mcp__cv__approve_cv');
    expect(options.permissionMode).toBe('dontAsk');
  });

  it("is isolated from the developer's Claude Code configuration", () => {
    expect(options.settingSources).toEqual([]);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toEqual({ disableClaudeAiConnectors: true });
  });

  it('keeps the caller environment and makes subagents run in the foreground', () => {
    expect(options.env).toMatchObject({ PATH: '/bin', HOME: '/h', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' });
  });

  it('installs the policy hook on PreToolUse', () => {
    expect(options.hooks?.PreToolUse?.[0]?.hooks).toHaveLength(1);
  });

  it('passes resume and budget only when configured', () => {
    expect(options).not.toHaveProperty('resume');
    expect(options).not.toHaveProperty('maxBudgetUsd');
    const resumed = buildAgentOptions({ config: { ...config, resume: 'sess-1', maxBudgetUsd: 2 }, store, tools });
    expect(resumed).toMatchObject({ resume: 'sess-1', maxBudgetUsd: 2 });
  });
});
