import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SkillLibrary, parseFrontmatter } from '../../src/skills';
import { SKILLS_DIR, tempDir } from '../helpers';

describe('parseFrontmatter', () => {
  it('reads flat keys, quotes and folded continuation lines', () => {
    const { data, body } = parseFrontmatter('---\nname: my-skill\ndescription: >\n  First line\n  second line\ntitle: "Quoted"\n---\n# Body\n');
    expect(data).toEqual({ name: 'my-skill', description: 'First line second line', title: 'Quoted' });
    expect(body).toBe('# Body\n');
  });
  it('returns the whole source when there is no frontmatter', () => {
    expect(parseFrontmatter('# Just markdown')).toEqual({ data: {}, body: '# Just markdown' });
  });
});

describe('SkillLibrary', () => {
  let tmp: Awaited<ReturnType<typeof tempDir>>;
  let lib: SkillLibrary;
  beforeEach(async () => {
    tmp = await tempDir();
    const dir = path.join(tmp.dir, 'writer', 'demo-skill');
    await mkdir(path.join(dir, 'references'), { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: demo-skill\ndescription: Demo for tests.\n---\n\n# Demo\nSee references/notes.md\n');
    await writeFile(path.join(dir, 'references', 'notes.md'), 'Notes!');
    await mkdir(path.join(tmp.dir, 'writer', 'not-a-skill'), { recursive: true });
    await writeFile(path.join(tmp.dir, 'secret.txt'), 'top secret');
    lib = new SkillLibrary(tmp.dir);
  });
  afterEach(() => tmp.cleanup());

  it('lists only folders with SKILL.md, per agent', async () => {
    expect((await lib.list('writer')).map((s) => s.name)).toEqual(['demo-skill']);
    expect(await lib.list('critic')).toEqual([]);
  });

  it('loads the body without frontmatter and lists bundled files', async () => {
    const skill = await lib.load('writer', 'demo-skill');
    expect(skill.content).toBe('# Demo\nSee references/notes.md');
    expect(skill.files).toEqual([path.join('references', 'notes.md')]);
  });

  it('loads bundled files', async () => {
    expect((await lib.load('writer', 'demo-skill', 'references/notes.md')).content).toBe('Notes!');
  });

  it('blocks path traversal and unknown skills', async () => {
    await expect(lib.load('writer', 'demo-skill', '../../secret.txt')).rejects.toThrow(/escapes/);
    await expect(lib.load('writer', 'nope')).rejects.toThrow(/Unknown skill "nope".*demo-skill/);
    await expect(lib.load('critic', 'demo-skill')).rejects.toThrow(/Unknown skill/);
    await expect(lib.load('writer', 'demo-skill', 'missing.md')).rejects.toThrow(/not found/);
  });
});

describe('bundled skills follow the Agent Skills convention', () => {
  const lib = new SkillLibrary(SKILLS_DIR);
  it.each(['coordinator', 'writer', 'critic'] as const)('%s has a valid sample skill', async (agent) => {
    const skills = await lib.list(agent);
    expect(skills.length).toBeGreaterThanOrEqual(1);
    for (const skill of skills) {
      expect(skill.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(skill.name.length).toBeLessThanOrEqual(64);
      expect(path.basename(skill.dir)).toBe(skill.name);
      expect(skill.description.length).toBeGreaterThan(20);
      expect(skill.description.length).toBeLessThanOrEqual(1024);
      expect(skill.description).toMatch(/Use (when|whenever)/);
      const loaded = await lib.load(agent, skill.name);
      expect(loaded.content).toMatch(/^# /);
      for (const file of loaded.files) {
        expect(loaded.content).toContain(file.split(path.sep).join('/'));
      }
    }
  });

  it('keeps one skills directory per agent type', async () => {
    expect((await readdir(SKILLS_DIR)).filter((d) => !d.startsWith('.')).sort()).toEqual(['coordinator', 'critic', 'writer']);
  });
});
