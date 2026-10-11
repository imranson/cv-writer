import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSkill, SkillError, SkillLibrary } from '../../src/skills/library.ts';
import { BUILTIN_SKILLS_DIR, tempDir } from '../support/env.ts';

let dir: string;
let cleanup: () => Promise<void>;
let lib: SkillLibrary;

beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  lib = new SkillLibrary(BUILTIN_SKILLS_DIR, path.join(dir, 'skills'));
});
afterEach(() => cleanup());

describe('built-in skills', () => {
  it('all parse with a name, description, audience and body', async () => {
    const files = (await readdir(BUILTIN_SKILLS_DIR)).filter((f) => f.endsWith('.md'));
    const skills = await lib.all();
    expect(skills).toHaveLength(files.length);
    for (const s of skills) {
      expect(s.source).toBe('builtin');
      expect(s.name).not.toBe(s.id);
      expect(s.description.length).toBeGreaterThan(20);
      expect(s.audience.length).toBeGreaterThan(0);
      expect(s.body.length).toBeGreaterThan(200);
    }
  });

  it('autoloads the core skill for each agent', async () => {
    expect((await lib.autoloaded('critic')).map((s) => s.id)).toContain('critique-rubric');
    expect((await lib.autoloaded('coordinator')).map((s) => s.id)).toContain('evidence-interviewing');
    expect((await lib.autoloaded('writer')).map((s) => s.id)).toContain('achievement-bullets');
  });
});

describe('SkillLibrary', () => {
  it('filters by audience and builds an index without autoloaded skills', async () => {
    const critic = await lib.list('critic');
    expect(critic.every((s) => s.audience.includes('critic'))).toBe(true);
    expect(critic.map((s) => s.id)).not.toContain('evidence-interviewing');
    const index = await lib.index('critic');
    expect(index).toContain('- common-cv-mistakes — Common CV mistakes:');
    expect(index).not.toContain('critique-rubric');
  });

  it('saves user skills, which can override built-ins and be reverted', async () => {
    const created = await lib.save({ name: 'Healthcare CVs', description: 'NHS conventions', audience: ['writer'], tags: ['nhs'], body: '# Tips\nUse band levels.' });
    expect(created).toMatchObject({ id: 'healthcare-cvs', source: 'user', audience: ['writer'], tags: ['nhs'], autoload: false });
    expect((await lib.list('critic')).map((s) => s.id)).not.toContain('healthcare-cvs');

    const override = await lib.save({ id: 'achievement-bullets', name: 'My bullets', description: 'Mine', body: 'Custom' });
    expect(override).toMatchObject({ source: 'user', overridesBuiltin: true, body: 'Custom' });
    await lib.delete('achievement-bullets');
    expect((await lib.get('achievement-bullets'))?.source).toBe('builtin');
  });

  it('validates input and protects built-ins', async () => {
    await expect(lib.save({ name: ' ', description: '', body: 'x' })).rejects.toBeInstanceOf(SkillError);
    await expect(lib.save({ name: 'X', description: '', body: ' ' })).rejects.toBeInstanceOf(SkillError);
    await expect(lib.save({ id: '../evil', name: 'X', description: '', body: 'x' })).rejects.toThrow(/Invalid skill id/);
    await expect(lib.delete('critique-rubric')).rejects.toBeInstanceOf(SkillError);
    expect(await lib.get('../../etc/passwd')).toBeNull();
  });

  it('defaults audience to every agent and ignores unknown audiences', () => {
    const s = parseSkill('x', '---\nname: X\naudience: [writer, robot]\n---\nBody', 'user');
    expect(s.audience).toEqual(['writer']);
    expect(parseSkill('y', 'No frontmatter', 'user')).toMatchObject({ name: 'y', audience: ['coordinator', 'writer', 'critic'], body: 'No frontmatter' });
  });
});
