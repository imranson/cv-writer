import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { AGENT_NAMES, type AgentName } from '../config.js';

/**
 * Agent skills following Anthropic's Agent Skills convention:
 *
 *   skills/<agent>/<skill-name>/SKILL.md      (YAML frontmatter: name, description)
 *   skills/<agent>/<skill-name>/references/*  (optional files loaded on demand)
 *
 * Progressive disclosure: only name + description go into the agent's system
 * prompt; the SKILL.md body (and any bundled file) is loaded with `loadSkill`.
 */

export interface SkillMeta {
  name: string;
  description: string;
  agent: AgentName;
  dir: string;
  files: string[];
}

export interface ParsedSkill {
  frontmatter: Record<string, unknown>;
  body: string;
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

export function parseSkillFile(source: string): ParsedSkill {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!m) throw new Error('SKILL.md must start with YAML frontmatter delimited by ---');
  const frontmatter = parseYaml(m[1]);
  if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) throw new Error('Frontmatter must be a YAML mapping');
  return { frontmatter: frontmatter as Record<string, unknown>, body: m[2].trim() };
}

export function validateFrontmatter(fm: Record<string, unknown>, dirName: string): { name: string; description: string } {
  const { name, description } = fm;
  if (typeof name !== 'string' || !NAME_RE.test(name) || name.length > 64) {
    throw new Error('name must be 1-64 chars of lowercase letters, digits and single hyphens');
  }
  if (/anthropic|claude/.test(name)) throw new Error('name must not contain reserved words');
  if (name !== dirName) throw new Error(`name "${name}" must match its directory "${dirName}"`);
  if (typeof description !== 'string' || !description.trim()) throw new Error('description is required');
  if (description.length > 1024) throw new Error('description must be at most 1024 characters');
  if (/<[^>]+>/.test(description)) throw new Error('description must not contain XML tags');
  return { name, description: description.trim().replace(/\s+/g, ' ') };
}

async function listFiles(dir: string, base = dir): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith('.')) continue;
    if (entry.isDirectory()) out.push(...(await listFiles(full, base)));
    else if (entry.name !== 'SKILL.md') out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out.sort();
}

export class SkillLibrary {
  private constructor(
    private readonly skills: Map<AgentName, SkillMeta[]>,
    readonly warnings: string[],
  ) {}

  static async load(rootDir: string): Promise<SkillLibrary> {
    const skills = new Map<AgentName, SkillMeta[]>();
    const warnings: string[] = [];
    for (const agent of AGENT_NAMES) {
      const list: SkillMeta[] = [];
      const agentDir = path.join(rootDir, agent);
      const entries = await readdir(agentDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(agentDir, entry.name);
        try {
          const { frontmatter } = parseSkillFile(await readFile(path.join(dir, 'SKILL.md'), 'utf8'));
          const { name, description } = validateFrontmatter(frontmatter, entry.name);
          list.push({ name, description, agent, dir, files: await listFiles(dir) });
        } catch (err) {
          warnings.push(`${agent}/${entry.name}: ${(err as Error).message}`);
        }
      }
      skills.set(agent, list.sort((a, b) => a.name.localeCompare(b.name)));
    }
    return new SkillLibrary(skills, warnings);
  }

  list(agent: AgentName): SkillMeta[] {
    return this.skills.get(agent) ?? [];
  }

  /** The skills block placed in an agent's system prompt (metadata only). */
  catalog(agent: AgentName): string {
    const list = this.list(agent);
    if (list.length === 0) return 'No skills are available.';
    return list.map((s) => `- ${s.name}: ${s.description}`).join('\n');
  }

  /** Loads a skill's instructions, or one of its bundled files. Agents can only load their own skills. */
  async load(agent: AgentName, name: string, file?: string): Promise<string> {
    const skill = this.list(agent).find((s) => s.name === name);
    if (!skill) {
      const available = this.list(agent).map((s) => s.name).join(', ') || 'none';
      throw new Error(`Unknown skill "${name}". Available skills: ${available}`);
    }
    if (file) {
      const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!skill.files.includes(normalized)) {
        throw new Error(`Skill "${name}" has no file "${file}". Files: ${skill.files.join(', ') || 'none'}`);
      }
      const full = path.resolve(skill.dir, normalized);
      if (!full.startsWith(skill.dir + path.sep) || !(await stat(full)).isFile()) throw new Error('Invalid skill file');
      return readFile(full, 'utf8');
    }
    const { body } = parseSkillFile(await readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'));
    const files = skill.files.length
      ? `\n\n---\nBundled files (load with loadSkill name="${name}" file="<path>"):\n${skill.files.map((f) => `- ${f}`).join('\n')}`
      : '';
    return `# Skill: ${name}\n\n${body}${files}`;
  }
}
