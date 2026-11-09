import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentType } from '../shared/events.js';

/**
 * Agent Skills, following Anthropic's convention: each skill is a folder containing `SKILL.md`
 * with YAML frontmatter (`name`, `description`) and a Markdown body, plus optional bundled files
 * (references/, scripts/, assets/). Agents only see name + description up front (progressive
 * disclosure) and pull the body — or a bundled file — in with `loadSkill` when relevant.
 *
 *   skills/<agentType>/<skill-name>/SKILL.md
 */

export interface SkillMeta {
  name: string;
  description: string;
  agent: AgentType;
  dir: string;
  files: string[];
}

export interface LoadedSkill extends SkillMeta {
  body: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSkillMarkdown(source: string): { frontmatter: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---');
  const fm = parseYaml(m[1]);
  if (!fm || typeof fm !== 'object') throw new Error('SKILL.md frontmatter must be a YAML mapping');
  return { frontmatter: fm as Record<string, unknown>, body: m[2].trim() };
}

export function validateSkillFrontmatter(fm: Record<string, unknown>, folderName: string): { name: string; description: string } {
  const name = fm.name;
  const description = fm.description;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > 64) {
    throw new Error(`Skill "${folderName}": name must be lowercase letters/digits/hyphens, max 64 chars`);
  }
  if (/anthropic|claude/.test(name)) throw new Error(`Skill "${name}": name may not contain reserved words`);
  if (name !== folderName) throw new Error(`Skill "${name}": name must match its folder name "${folderName}"`);
  if (typeof description !== 'string' || !description.trim() || description.length > 1024) {
    throw new Error(`Skill "${name}": description is required (max 1024 chars)`);
  }
  return { name, description: description.trim() };
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.name !== 'SKILL.md') out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

export class SkillRegistry {
  constructor(private readonly root: string) {}

  async list(agent: AgentType): Promise<SkillMeta[]> {
    const dir = path.join(this.root, agent);
    let entries: string[] = [];
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
    const skills: SkillMeta[] = [];
    for (const folder of entries.sort()) {
      const skillDir = path.join(dir, folder);
      try {
        const { frontmatter } = parseSkillMarkdown(await readFile(path.join(skillDir, 'SKILL.md'), 'utf8'));
        const { name, description } = validateSkillFrontmatter(frontmatter, folder);
        skills.push({ name, description, agent, dir: skillDir, files: await listFiles(skillDir) });
      } catch (err) {
        console.warn(`[skills] skipping ${agent}/${folder}: ${(err as Error).message}`);
      }
    }
    return skills;
  }

  /** Loads a skill's instructions, or one of its bundled files when `file` is given. */
  async load(agent: AgentType, name: string, file?: string): Promise<{ skill: SkillMeta; content: string }> {
    const skill = (await this.list(agent)).find((s) => s.name === name);
    if (!skill) {
      const available = (await this.list(agent)).map((s) => s.name).join(', ') || 'none';
      throw new Error(`Unknown skill "${name}" for the ${agent} agent. Available: ${available}`);
    }
    if (!file) {
      const { body } = parseSkillMarkdown(await readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'));
      return { skill, content: body };
    }
    const target = path.resolve(skill.dir, file);
    if (!target.startsWith(skill.dir + path.sep)) throw new Error('File path escapes the skill folder');
    if (!(await stat(target).catch(() => null))?.isFile()) {
      throw new Error(`Skill "${name}" has no file "${file}". Files: ${skill.files.join(', ') || 'none'}`);
    }
    return { skill, content: await readFile(target, 'utf8') };
  }
}
