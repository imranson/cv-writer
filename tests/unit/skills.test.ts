import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSkillFile, SkillLibrary, validateFrontmatter } from '../../src/skills/loader.js';
import { ROOT } from '../helpers/env.js';

describe('skills (Anthropic SKILL.md convention)', () => {
  it('parses YAML frontmatter and body', () => {
    const parsed = parseSkillFile('---\nname: my-skill\ndescription: Does a thing. Use when needed.\n---\n\n# Body\n');
    expect(parsed.frontmatter).toEqual({ name: 'my-skill', description: 'Does a thing. Use when needed.' });
    expect(parsed.body).toBe('# Body');
    expect(() => parseSkillFile('# no frontmatter')).toThrow('frontmatter');
  });

  it('validates name and description rules', () => {
    expect(validateFrontmatter({ name: 'a-b', description: 'x' }, 'a-b')).toEqual({ name: 'a-b', description: 'x' });
    expect(() => validateFrontmatter({ name: 'A_B', description: 'x' }, 'A_B')).toThrow('lowercase');
    expect(() => validateFrontmatter({ name: 'a-b', description: 'x' }, 'other')).toThrow('match its directory');
    expect(() => validateFrontmatter({ name: 'claude-x', description: 'x' }, 'claude-x')).toThrow('reserved');
    expect(() => validateFrontmatter({ name: 'a', description: '' }, 'a')).toThrow('description is required');
    expect(() => validateFrontmatter({ name: 'a', description: 'x'.repeat(1025) }, 'a')).toThrow('1024');
    expect(() => validateFrontmatter({ name: 'a', description: '<b>x</b>' }, 'a')).toThrow('XML');
  });

  it('ships one valid sample skill per agent', async () => {
    const lib = await SkillLibrary.load(path.join(ROOT, 'skills'));
    expect(lib.warnings).toEqual([]);
    expect(lib.list('coordinator').map((s) => s.name)).toEqual(['cv-intake-interview']);
    expect(lib.list('writer').map((s) => s.name)).toEqual(['ats-cv-writing']);
    expect(lib.list('critic').map((s) => s.name)).toEqual(['cv-review-rubric']);
    expect(lib.catalog('writer')).toMatch(/^- ats-cv-writing: .+Use before writing/);
  });

  it('loads bodies and bundled files progressively, scoped per agent', async () => {
    const lib = await SkillLibrary.load(path.join(ROOT, 'skills'));
    const body = await lib.load('coordinator', 'cv-intake-interview');
    expect(body).toContain('# Skill: cv-intake-interview');
    expect(body).not.toContain('description:');
    expect(body).toContain('references/profile-schema.md');
    expect(await lib.load('writer', 'ats-cv-writing', 'references/cv-template.html')).toContain('class="cv-header"');
    await expect(lib.load('critic', 'ats-cv-writing')).rejects.toThrow('Unknown skill');
    await expect(lib.load('writer', 'ats-cv-writing', '../../coordinator/cv-intake-interview/SKILL.md')).rejects.toThrow('has no file');
  });

  it('skips invalid skills with a warning', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'skills-'));
    await mkdir(path.join(dir, 'writer', 'good'), { recursive: true });
    await mkdir(path.join(dir, 'writer', 'bad'), { recursive: true });
    await writeFile(path.join(dir, 'writer', 'good', 'SKILL.md'), '---\nname: good\ndescription: ok\n---\nBody');
    await writeFile(path.join(dir, 'writer', 'bad', 'SKILL.md'), '---\nname: wrong-name\ndescription: ok\n---\nBody');
    const lib = await SkillLibrary.load(dir);
    expect(lib.list('writer').map((s) => s.name)).toEqual(['good']);
    expect(lib.warnings[0]).toMatch(/writer\/bad: name "wrong-name" must match/);
    expect(lib.catalog('critic')).toBe('No skills are available.');
  });
});
