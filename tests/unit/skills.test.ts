import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadSkills, parseSkill, renderSkills } from '../../src/skills/loader.js';
import { SKILLS_DIR, tempDir } from '../support/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => ({ dir, cleanup } = await tempDir()));
afterEach(() => cleanup());

describe('skills', () => {
  it('parses frontmatter', () => {
    expect(parseSkill('---\nname: bullets\ndescription: "Write bullets"\n---\nUse verbs.', '/x/a.md')).toEqual({
      name: 'bullets',
      description: 'Write bullets',
      content: 'Use verbs.',
      file: '/x/a.md',
    });
    expect(parseSkill('Plain body', '/x/plain.md')).toMatchObject({ name: 'plain', content: 'Plain body' });
  });

  it('loads only the given agent directory, skipping README and non-markdown files', async () => {
    await mkdir(path.join(dir, 'writer'), { recursive: true });
    await mkdir(path.join(dir, 'critic'), { recursive: true });
    await writeFile(path.join(dir, 'writer', 'b.md'), 'B');
    await writeFile(path.join(dir, 'writer', 'a.md'), '---\nname: alpha\n---\nA');
    await writeFile(path.join(dir, 'writer', 'README.md'), 'docs');
    await writeFile(path.join(dir, 'writer', 'notes.txt'), 'ignored');
    await writeFile(path.join(dir, 'critic', 'c.md'), 'C');
    expect((await loadSkills(dir, 'writer')).map((s) => s.name)).toEqual(['alpha', 'b']);
    expect((await loadSkills(dir, 'critic')).map((s) => s.name)).toEqual(['c']);
    expect(await loadSkills(dir, 'coordinator')).toEqual([]);
  });

  it('renders skills for the system prompt', () => {
    expect(renderSkills([])).toBe('');
    const text = renderSkills([{ name: 'alpha', description: 'd', content: 'Do X', file: '' }]);
    expect(text).toContain('## Skills');
    expect(text).toContain('### Skill: alpha');
    expect(text).toContain('Do X');
  });

  it('ships one skills directory per agent type', async () => {
    for (const agent of ['coordinator', 'writer', 'critic'] as const) {
      expect((await loadSkills(SKILLS_DIR, agent)).length).toBeGreaterThan(0);
    }
  });
});
