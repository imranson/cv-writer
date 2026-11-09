import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parseSkillMarkdown, SkillRegistry, validateSkillFrontmatter } from '../../src/agents/skills.js';
import { SKILLS_DIR } from '../helpers.js';

describe('SKILL.md parsing', () => {
  it('splits YAML frontmatter and body', () => {
    const { frontmatter, body } = parseSkillMarkdown('---\nname: my-skill\ndescription: Does things. Use when X.\n---\n# Title\nBody');
    expect(frontmatter).toEqual({ name: 'my-skill', description: 'Does things. Use when X.' });
    expect(body).toBe('# Title\nBody');
  });

  it('requires frontmatter', () => {
    expect(() => parseSkillMarkdown('# No frontmatter')).toThrow(/frontmatter/);
  });

  it('validates name and description per the Agent Skills convention', () => {
    expect(validateSkillFrontmatter({ name: 'good-name', description: 'ok' }, 'good-name')).toEqual({ name: 'good-name', description: 'ok' });
    expect(() => validateSkillFrontmatter({ name: 'Bad_Name', description: 'ok' }, 'Bad_Name')).toThrow(/lowercase/);
    expect(() => validateSkillFrontmatter({ name: 'a'.repeat(65), description: 'ok' }, 'a'.repeat(65))).toThrow(/max 64/);
    expect(() => validateSkillFrontmatter({ name: 'claude-helper', description: 'ok' }, 'claude-helper')).toThrow(/reserved/);
    expect(() => validateSkillFrontmatter({ name: 'x', description: 'ok' }, 'y')).toThrow(/match its folder/);
    expect(() => validateSkillFrontmatter({ name: 'x', description: '' }, 'x')).toThrow(/description/);
    expect(() => validateSkillFrontmatter({ name: 'x', description: 'd'.repeat(1025) }, 'x')).toThrow(/description/);
  });
});

describe('bundled sample skills', () => {
  const registry = new SkillRegistry(SKILLS_DIR);

  it('each agent type has its own valid sample skill', async () => {
    expect((await registry.list('coordinator')).map((s) => s.name)).toEqual(['cv-intake-interview']);
    expect((await registry.list('writer')).map((s) => s.name)).toEqual(['ats-cv-writing']);
    expect((await registry.list('critic')).map((s) => s.name)).toEqual(['cv-review-rubric']);
  });

  it('lists bundled resource files and loads them on demand', async () => {
    const [writer] = await registry.list('writer');
    expect(writer.files).toEqual(['assets/cv-skeleton.html']);
    const body = await registry.load('writer', 'ats-cv-writing');
    expect(body.content).toMatch(/^# ATS-friendly CV writing/);
    expect(body.content).not.toContain('description:');
    const asset = await registry.load('writer', 'ats-cv-writing', 'assets/cv-skeleton.html');
    expect(asset.content).toContain('<header>');
  });

  it('keeps skills scoped to their agent and blocks path traversal', async () => {
    await expect(registry.load('critic', 'ats-cv-writing')).rejects.toThrow(/Unknown skill.*Available: cv-review-rubric/);
    await expect(registry.load('writer', 'ats-cv-writing', '../../critic/cv-review-rubric/SKILL.md')).rejects.toThrow(/escapes/);
    await expect(registry.load('writer', 'ats-cv-writing', 'missing.md')).rejects.toThrow(/has no file/);
  });
});

describe('SkillRegistry with invalid skills', () => {
  it('skips invalid skill folders with a warning and returns [] for missing agents', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'skills-'));
    await mkdir(path.join(root, 'writer', 'ok-skill'), { recursive: true });
    await writeFile(path.join(root, 'writer', 'ok-skill', 'SKILL.md'), '---\nname: ok-skill\ndescription: Fine.\n---\nBody');
    await mkdir(path.join(root, 'writer', 'broken'), { recursive: true });
    await writeFile(path.join(root, 'writer', 'broken', 'SKILL.md'), 'no frontmatter');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const reg = new SkillRegistry(root);
    expect((await reg.list('writer')).map((s) => s.name)).toEqual(['ok-skill']);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    expect(await reg.list('critic')).toEqual([]);
    warn.mockRestore();
  });
});
