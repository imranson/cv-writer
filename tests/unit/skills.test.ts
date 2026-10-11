import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findSkill, loadSkills, parseSkill, renderSkills } from '../../src/skills/loader.js';
import { loadSkillTool } from '../../src/tools/skills.js';
import { executeToolCall } from '../../src/tools/tool.js';
import { SKILLS_DIR, tempDir, toolContext } from '../support/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

/** Writes `<dir>/<agent>/<skill>/<file>`, creating directories. */
async function put(agent: string, skill: string, file: string, content: string | Buffer) {
  const target = path.join(dir, agent, skill, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

describe('skills', () => {
  it('parses SKILL.md frontmatter, defaulting the name to the directory', () => {
    expect(parseSkill('---\nname: bullets\ndescription: "Write bullets"\n---\nUse verbs.', '/x/bullets')).toEqual({
      name: 'bullets',
      description: 'Write bullets',
      content: 'Use verbs.',
      dir: '/x/bullets',
    });
    expect(parseSkill('Plain body', '/x/plain')).toMatchObject({ name: 'plain', content: 'Plain body' });
  });

  it('loads <agent>/<skill>/SKILL.md for the given agent only, skipping loose files and dirs without SKILL.md', async () => {
    await put('writer', 'b', 'SKILL.md', 'B');
    await put('writer', 'a', 'SKILL.md', '---\nname: alpha\n---\nA');
    await put('writer', 'empty', 'notes.md', 'no SKILL.md here');
    await writeFile(path.join(dir, 'writer', 'README.md'), 'docs');
    await put('critic', 'c', 'SKILL.md', 'C');
    expect((await loadSkills(dir, 'writer')).map((s) => s.name)).toEqual(['alpha', 'b']);
    expect((await loadSkills(dir, 'critic')).map((s) => s.name)).toEqual(['c']);
    expect(await loadSkills(dir, 'coordinator')).toEqual([]);
  });

  it('renders only a name/description index for the system prompt', () => {
    expect(renderSkills([])).toBe('');
    const text = renderSkills([
      { name: 'alpha', description: 'Load before X', content: 'Do X', dir: '' },
      { name: 'beta', content: 'Do Y', dir: '' },
    ]);
    expect(text).toContain('## Skills');
    expect(text).toContain('loadSkill');
    expect(text).toContain('- alpha: Load before X\n- beta');
    expect(text).not.toContain('Do X');
    expect(text).not.toContain('Do Y');
  });

  describe('loadSkill tool', () => {
    const run = (args: Record<string, unknown>) =>
      executeToolCall([loadSkillTool(dir)], { function: { name: 'loadSkill', arguments: args } }, toolContext());

    it('loads SKILL.md on demand, scoped to the calling agent and read fresh from disk', async () => {
      const file = await put('coordinator', 'alpha', 'SKILL.md', '---\nname: alpha\n---\nDo X');
      await put('critic', 'c', 'SKILL.md', 'C');
      expect(await run({ name: 'alpha' })).toMatchObject({ ok: true, output: '# Skill: alpha\n\nDo X' });
      await writeFile(file, '---\nname: alpha\n---\nDo Z');
      expect((await run({ name: 'alpha' })).output).toContain('Do Z');
      expect(await run({ name: 'c' })).toMatchObject({ ok: false, output: 'Error: unknown skill "c". Available skills: alpha' });
      await expect(findSkill(dir, 'writer', 'x')).rejects.toThrow('Available skills: (none)');
    });

    it('lists bundled files and reads them by relative path', async () => {
      await put('coordinator', 'alpha', 'SKILL.md', 'See references/guide.md');
      await put('coordinator', 'alpha', 'references/guide.md', 'Guide text');
      await put('coordinator', 'alpha', 'assets/template.html', '<p>tpl</p>');
      await put('coordinator', 'alpha', 'scripts/count.py', 'print(1)');
      expect((await run({ name: 'alpha' })).output).toBe(
        '# Skill: alpha\n\nSee references/guide.md\n\n## Bundled files\n- assets/template.html\n- references/guide.md\n- scripts/count.py',
      );
      expect(await run({ name: 'alpha', file: 'references/guide.md' })).toMatchObject({ ok: true, output: 'Guide text' });
      expect(await run({ name: 'alpha', file: 'scripts/count.py' })).toMatchObject({ ok: true, output: 'print(1)' });
    });

    it('refuses missing, binary and out-of-skill files', async () => {
      await put('coordinator', 'alpha', 'SKILL.md', 'A');
      await put('coordinator', 'beta', 'SKILL.md', 'secret');
      await put('coordinator', 'alpha', 'assets/logo.png', Buffer.from([0x89, 0x50, 0x00, 0x01]));
      await symlink(path.join(dir, 'coordinator', 'beta', 'SKILL.md'), path.join(dir, 'coordinator', 'alpha', 'link.md'));
      expect((await run({ name: 'alpha', file: 'nope.md' })).output).toBe('Error: skill "alpha" has no file "nope.md"');
      expect((await run({ name: 'alpha', file: 'assets/logo.png' })).output).toContain('binary file');
      for (const file of ['../beta/SKILL.md', path.join(dir, 'coordinator', 'beta', 'SKILL.md'), 'link.md']) {
        expect((await run({ name: 'alpha', file })).output).toContain('is outside skill "alpha"');
      }
    });
  });

  it('ships one skills directory per agent type, each skill as <name>/SKILL.md with a matching name and a description', async () => {
    for (const agent of ['coordinator', 'writer', 'critic'] as const) {
      const skills = await loadSkills(SKILLS_DIR, agent);
      expect(skills.length).toBeGreaterThan(0);
      for (const s of skills) {
        expect(s.name).toBe(path.basename(s.dir));
        expect(s.description).toBeTruthy();
      }
    }
  });
});
