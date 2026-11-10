import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AGENT_TOOLS, buildSystemPrompt } from '../../src/agents/definitions.js';
import { defineTool, executeTool, normalizeArgs, serializeResult, toToolSpec, ToolError } from '../../src/agents/tools/types.js';

const names = (agent: keyof typeof AGENT_TOOLS) => AGENT_TOOLS[agent].map((t) => t.name).sort();

describe('agent tool sets (permission boundaries from the spec)', () => {
  const common = ['evalMath', 'webFetch', 'webSearch'];
  it('coordinator', () => {
    expect(names('coordinator')).toEqual(
      ['readProfile', 'editProfile', 'readJob', 'editJob', 'readCV', 'readCSS', 'readPreferences', 'editPreferences', 'callWriter', 'callCritic', 'loadSkill', ...common].sort(),
    );
  });
  it('writer', () => {
    expect(names('writer')).toEqual(
      ['readCV', 'editCV', 'readCSS', 'editCSS', 'readProfile', 'readJob', 'readPreferences', 'loadSkill', 'callCritic', ...common].sort(),
    );
  });
  it('critic', () => {
    expect(names('critic')).toEqual(['readCV', 'readJob', 'readPreferences', 'loadSkill', ...common].sort());
  });
  it('only the coordinator can call the writer; nobody but writer can edit the CV', () => {
    expect(names('writer')).not.toContain('callWriter');
    expect(names('critic')).not.toContain('callCritic');
    expect(names('coordinator')).not.toContain('editCV');
    expect(names('coordinator')).not.toContain('editCSS');
  });
});

describe('tool specs', () => {
  it('produce Ollama function schemas without $schema noise', () => {
    for (const tools of Object.values(AGENT_TOOLS)) {
      for (const t of tools) {
        const spec = toToolSpec(t);
        expect(spec.type).toBe('function');
        expect(spec.function.name).toBe(t.name);
        expect(spec.function.description.length).toBeGreaterThan(20);
        expect(spec.function.parameters).toMatchObject({ type: 'object' });
        expect(JSON.stringify(spec)).not.toContain('$schema');
      }
    }
  });
});

describe('argument normalisation and validation', () => {
  const tool = defineTool({
    name: 'demo',
    description: 'demo tool',
    schema: z.object({ name: z.string().optional(), patch: z.record(z.string(), z.any()).optional(), n: z.number().optional() }),
    run: async (args) => args,
  });
  const ctx = {} as any;

  it('parses string arguments and stringified objects; drops null/empty optionals', () => {
    expect(normalizeArgs(tool, '{"patch":"{\\"a\\":1}","name":"","n":null}')).toEqual({ patch: { a: 1 } });
    expect(normalizeArgs(tool, undefined)).toEqual({});
    expect(() => normalizeArgs(tool, 'not json')).toThrow(ToolError);
    expect(() => normalizeArgs(tool, [1])).toThrow(/JSON object/);
  });

  it('reports schema violations as ToolError', async () => {
    await expect(executeTool(tool, { n: 'five' }, ctx)).rejects.toThrow(/Invalid arguments for demo: n:/);
    await expect(executeTool(tool, { name: 'x' }, ctx)).resolves.toEqual({ name: 'x' });
  });

  it('serialises and caps results', () => {
    expect(serializeResult('plain')).toBe('plain');
    expect(serializeResult({ a: 1 })).toBe('{\n "a": 1\n}');
    expect(serializeResult(undefined)).toBe('null');
    const capped = serializeResult('z'.repeat(50), 10);
    expect(capped).toMatch(/^z{10}\n…\[truncated 40 characters\]$/);
  });
});

describe('system prompts', () => {
  it('list skills by name + description (progressive disclosure)', () => {
    const p = buildSystemPrompt('critic', [{ name: 'cv-review-rubric', description: 'Rubric. Use when reviewing.', agent: 'critic', dir: '', files: [] }]);
    expect(p).toContain('You are the Critic subagent');
    expect(p).toContain('- cv-review-rubric: Rubric. Use when reviewing.');
    expect(buildSystemPrompt('writer', [])).toContain('No skills are installed');
  });
});
