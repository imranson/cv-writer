import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { AgentName } from './config';

export interface SkillMeta {
  name: string;
  description: string;
  dir: string;
}

export interface LoadedSkill extends SkillMeta {
  file: string;
  content: string;
  /** Other files bundled with the skill (relative paths), loadable via `file`. */
  files: string[];
}

/** Parses the `---` YAML frontmatter used by SKILL.md (flat `key: value` pairs, folded continuations). */
export function parseFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return { data: {}, body: source };
  const data: Record<string, string> = {};
  let currentKey: string | undefined;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) {
      currentKey = kv[1];
      const raw = kv[2].trim();
      data[currentKey] = raw === '>' || raw === '|' ? '' : unquote(raw);
    } else if (currentKey && /^\s+\S/.test(line)) {
      data[currentKey] = `${data[currentKey]} ${line.trim()}`.trim();
    }
  }
  return { data, body: match[2] };
}

function unquote(v: string): string {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

export class SkillLibrary {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Lists skills for one agent type: `<root>/<agent>/<skill>/SKILL.md`. */
  async list(agent: AgentName): Promise<SkillMeta[]> {
    const agentDir = path.join(this.root, agent);
    let entries: string[];
    try {
      entries = await fs.readdir(agentDir);
    } catch {
      return [];
    }
    const skills: SkillMeta[] = [];
    for (const entry of entries.sort()) {
      const dir = path.join(agentDir, entry);
      const text = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => undefined);
      if (text === undefined) continue;
      const { data } = parseFrontmatter(text);
      skills.push({ name: data.name || entry, description: data.description || '', dir });
    }
    return skills;
  }

  async load(agent: AgentName, name: string, file = 'SKILL.md'): Promise<LoadedSkill> {
    const skills = await this.list(agent);
    const skill = skills.find((s) => s.name === name);
    if (!skill) {
      const available = skills.map((s) => s.name).join(', ') || 'none';
      throw new Error(`Unknown skill "${name}" for ${agent}. Available: ${available}`);
    }
    const target = path.resolve(skill.dir, file);
    if (target !== skill.dir && !target.startsWith(skill.dir + path.sep)) {
      throw new Error('Skill file path escapes the skill directory');
    }
    const raw = await fs.readFile(target, 'utf8').catch(() => {
      throw new Error(`File "${file}" not found in skill "${name}"`);
    });
    const files = (await walk(skill.dir)).map((f) => path.relative(skill.dir, f)).filter((f) => f !== 'SKILL.md');
    const content = file === 'SKILL.md' ? parseFrontmatter(raw).body.trim() : raw;
    return { ...skill, file, content, files };
  }
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out.sort();
}
