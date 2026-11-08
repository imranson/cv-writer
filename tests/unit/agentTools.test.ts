import { describe, expect, it } from 'vitest';
import { AGENT_TOOLS, toolNames } from '../../src/agents/tools/index.js';
import { toToolSchema } from '../../src/agents/tool.js';
import { BASE_PROMPTS, buildSystemPrompt } from '../../src/agents/prompts.js';

const COMMON = ['evalMath', 'webSearch', 'webFetch'];

describe('agent tool sets (spec)', () => {
  it('coordinator has exactly its tools plus the common ones', () => {
    expect(toolNames('coordinator').sort()).toEqual(
      ['readProfile', 'editProfile', 'readJob', 'editJob', 'readCV', 'readCSS', 'readPreferences', 'editPreferences', 'callWriter', 'callCritic', 'loadSkill', ...COMMON].sort(),
    );
  });

  it('writer has exactly its tools plus the common ones', () => {
    expect(toolNames('writer').sort()).toEqual(
      ['readCV', 'editCV', 'readCSS', 'editCSS', 'readProfile', 'readJob', 'readPreferences', 'loadSkill', 'callCritic', ...COMMON].sort(),
    );
  });

  it('critic has exactly its tools plus the common ones and cannot write or delegate', () => {
    expect(toolNames('critic').sort()).toEqual(['readCV', 'readJob', 'readPreferences', 'loadSkill', ...COMMON].sort());
    expect(toolNames('critic').some((n) => n.startsWith('edit') || n.startsWith('call'))).toBe(false);
  });

  it('only the coordinator can call the writer; nobody but coordinator edits profile/jobs/preferences', () => {
    expect(toolNames('writer')).not.toContain('callWriter');
    for (const agent of ['writer', 'critic'] as const) {
      for (const t of ['editProfile', 'editJob', 'editPreferences']) expect(toolNames(agent)).not.toContain(t);
    }
    expect(toolNames('coordinator')).not.toContain('editCV');
    expect(toolNames('coordinator')).not.toContain('editCSS');
  });

  it('produces valid JSON-schema tool definitions for Ollama', () => {
    for (const tools of Object.values(AGENT_TOOLS)) {
      for (const tool of tools) {
        const schema = toToolSchema(tool);
        expect(schema.type).toBe('function');
        expect(schema.function.parameters.type).toBe('object');
        expect(schema.function.parameters).not.toHaveProperty('$schema');
        expect(schema.function.description.length).toBeGreaterThan(20);
      }
    }
    const edit = toToolSchema(AGENT_TOOLS.coordinator.find((t) => t.name === 'editProfile')!);
    expect(Object.keys((edit.function.parameters as any).properties)).toEqual(['profile', 'operations']);
  });

  it('system prompts name the agent role, tools and skills catalog', () => {
    const prompt = buildSystemPrompt('coordinator', '- cv-intake-interview: x', toolNames('coordinator'));
    expect(prompt).toContain('ONLY agent that talks to the user');
    expect(prompt).toContain('callWriter');
    expect(prompt).toContain('- cv-intake-interview: x');
    expect(BASE_PROMPTS.writer).toMatch(/never talk to the user/);
    expect(BASE_PROMPTS.critic).toMatch(/never edit anything/);
  });
});
