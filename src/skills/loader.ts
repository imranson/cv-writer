import { readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from '../config.js';

export const SKILL_FILE = 'SKILL.md';

export interface Skill {
  name: string;
  description?: string;
  /** SKILL.md body, without frontmatter. */
  content: string;
  /** The skill's directory, holding SKILL.md and any bundled files (scripts/, references/, assets/, …). */
  dir: string;
}

/** Parses SKILL.md with optional `---` frontmatter of simple `key: value` lines. `name` defaults to the directory name. */
export function parseSkill(raw: string, dir: string): Skill {
  const fallbackName = path.basename(dir);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { name: fallbackName, content: raw.trim(), dir };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: meta.name || fallbackName, description: meta.description, content: raw.slice(match[0].length).trim(), dir };
}

/** Loads `<skillsDir>/<agent>/<skill>/SKILL.md`. Read on every run so edits apply without a restart. */
export async function loadSkills(skillsDir: string, agent: AgentName): Promise<Skill[]> {
  const root = path.join(skillsDir, agent);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)).sort();
  const skills = await Promise.all(
    dirs.map(async (dir) => {
      try {
        return parseSkill(await readFile(path.join(dir, SKILL_FILE), 'utf8'), dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw err;
      }
    }),
  );
  return skills.filter((s) => s !== undefined);
}

/** Progressive disclosure: the system prompt lists skills by name and description only; loadSkill returns the body. */
export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const index = skills.map((s) => `- ${s.name}${s.description ? `: ${s.description}` : ''}`).join('\n');
  return (
    '## Skills\nDetailed guidance for specific tasks. Before starting a task a skill covers, call loadSkill with its name and ' +
    'follow it. Loaded skills stay in this conversation; do not reload one that is already here.\n\n' +
    index
  );
}

/** Finds one of the agent's skills by name, read fresh from disk. */
export async function findSkill(skillsDir: string, agent: AgentName, name: string): Promise<Skill> {
  const skills = await loadSkills(skillsDir, agent);
  const skill = skills.find((s) => s.name === name.trim());
  if (!skill) {
    throw new Error(`unknown skill "${name}". Available skills: ${skills.map((s) => s.name).join(', ') || '(none)'}`);
  }
  return skill;
}

/** Paths of the files bundled with a skill, relative to its directory, excluding SKILL.md. */
export async function listSkillFiles(skill: Skill): Promise<string[]> {
  const entries = await readdir(skill.dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => path.relative(skill.dir, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
    .filter((f) => f !== SKILL_FILE)
    .sort();
}

/** Reads a text file bundled with a skill. Refuses paths (or symlinks) leading outside the skill's directory. */
export async function readSkillFile(skill: Skill, file: string): Promise<string> {
  const root = await realpath(skill.dir);
  let target: string;
  try {
    target = await realpath(path.resolve(root, file));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new Error(`skill "${skill.name}" has no file "${file}"`);
    throw err;
  }
  const rel = path.relative(root, target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`"${file}" is outside skill "${skill.name}"`);
  const data = await readFile(target);
  if (data.includes(0)) throw new Error(`"${file}" is a binary file and cannot be shown`);
  return data.toString('utf8');
}
