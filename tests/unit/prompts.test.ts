import { describe, expect, it } from 'vitest';
import { BASE_PROMPTS, buildSystemPrompt, formatSkills, formatSystemInfo } from '../../src/agents/prompts';

const info = {
  now: new Date('2026-10-21T12:00:00Z'),
  timeZone: 'Europe/London',
  model: 'kimi-k2.6:cloud',
  usedTokens: 5000,
  contextWindow: 262144,
  estimated: true,
};

describe('system information', () => {
  it('includes date/time and the context window indicator', () => {
    const text = formatSystemInfo(info);
    expect(text).toContain('Wednesday, 21 October 2026 at 13:00');
    expect(text).toContain('Europe/London');
    expect(text).toContain('2026-10-21T12:00:00.000Z');
    expect(text).toContain('Context window: 5,000 of 262,144 tokens used (1.9%) (estimated); model kimi-k2.6:cloud');
  });

  it('mentions the job open in the UI', () => {
    expect(formatSystemInfo({ ...info, activeJob: { id: 'j1', title: 'Engineer', company: 'Acme' } })).toContain('Engineer at Acme (jobId: j1)');
  });
});

describe('skills listing', () => {
  it('lists name and description for progressive disclosure', () => {
    expect(formatSkills([{ name: 'a-skill', description: 'Does A.', dir: '/x' }])).toContain('- a-skill: Does A.');
    expect(formatSkills([])).toContain('No skills installed');
  });
});

describe('buildSystemPrompt', () => {
  it.each(['coordinator', 'writer', 'critic'] as const)('%s prompt has role, skills and system info', (agent) => {
    const prompt = buildSystemPrompt(agent, [], info);
    expect(prompt.startsWith(BASE_PROMPTS[agent])).toBe(true);
    expect(prompt).toContain('# Skills');
    expect(prompt).toContain('# System information');
  });

  it('makes the coordinator the only agent that talks to the user', () => {
    expect(BASE_PROMPTS.coordinator).toMatch(/ONLY agent that talks to the user/);
    expect(BASE_PROMPTS.writer).toMatch(/user does not see it directly/);
  });

  it('forbids padding with invented facts and makes the critic fact-check', () => {
    expect(BASE_PROMPTS.writer).toMatch(/maxPages is a limit, not a target/);
    expect(BASE_PROMPTS.writer).toMatch(/adding claims is not/);
    expect(BASE_PROMPTS.critic).toMatch(/Fact-check first/);
    expect(BASE_PROMPTS.critic).toMatch(/Unsupported claims:/);
  });
});
