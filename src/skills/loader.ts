import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from '../config.js';

export interface Skill {
  name: string;
  description?: string;
  content: string;
  file: string;
}

/** Parses optional `---` frontmatter of simple `key: value` lines. */
export function parseSkill(raw: string, file: string): Skill {
  const fallbackName = path.basename(file, '.md');
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!match) return { name: fallbackName, content: raw.trim(), file };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].trim().replace(/^["']|["']$/g, '');
  }
  return { name: meta.name || fallbackName, description: meta.description, content: raw.slice(match[0].length).trim(), file };
}

/** Loads `<skillsDir>/<agent>/*.md`. Read on every run so edits apply without a restart. */
export async function loadSkills(skillsDir: string, agent: AgentName): Promise<Skill[]> {
  const dir = path.join(skillsDir, agent);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const files = names.filter((n) => n.endsWith('.md') && n.toLowerCase() !== 'readme.md').sort();
  return Promise.all(files.map(async (f) => parseSkill(await readFile(path.join(dir, f), 'utf8'), path.join(dir, f))));
}

export function renderSkills(skills: Skill[]): string {
  if (skills.length === 0) return '';
  const body = skills
    .map((s) => `### Skill: ${s.name}${s.description ? `\n_${s.description}_` : ''}\n\n${s.content}`)
    .join('\n\n');
  return `## Skills\nApply these skills when relevant.\n\n${body}`;
}
