import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { AgentName } from '../agents/events.ts';
import { readOptional, writeAtomic } from '../util/fs.ts';
import { parseFrontmatter, stringifyFrontmatter } from '../util/frontmatter.ts';
import { assertValidId, slugify } from '../util/ids.ts';

export const AUDIENCES: AgentName[] = ['coordinator', 'writer', 'critic'];

export interface SkillMeta {
  id: string;
  name: string;
  description: string;
  /** Which agents the skill is relevant to. */
  audience: AgentName[];
  tags: string[];
  /** When true the full skill is placed in the system prompt of its audience instead of loaded on demand. */
  autoload: boolean;
  source: 'builtin' | 'user';
  /** True for a user skill that shadows a built-in skill with the same id. */
  overridesBuiltin?: boolean;
}

export interface Skill extends SkillMeta {
  body: string;
}

export interface SkillInput {
  id?: string;
  name: string;
  description: string;
  audience?: AgentName[];
  tags?: string[];
  autoload?: boolean;
  body: string;
}

export class SkillError extends Error {}

function toStringList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === 'string' && v.trim()) return v.split(',').map((s) => s.trim());
  return [];
}

export function parseSkill(id: string, text: string, source: Skill['source']): Skill {
  const { data, body } = parseFrontmatter(text);
  const audience = toStringList(data.audience).filter((a): a is AgentName => (AUDIENCES as string[]).includes(a));
  return {
    id,
    name: typeof data.name === 'string' && data.name ? data.name : id,
    description: typeof data.description === 'string' ? data.description : '',
    audience: audience.length ? audience : [...AUDIENCES],
    tags: toStringList(data.tags),
    autoload: data.autoload === true,
    source,
    body: body.trim(),
  };
}

export function serializeSkill(skill: Omit<Skill, 'source' | 'id'>): string {
  return stringifyFrontmatter(
    {
      name: skill.name,
      description: skill.description,
      audience: skill.audience,
      tags: skill.tags,
      autoload: skill.autoload,
    },
    skill.body,
  );
}

/**
 * Expert CV advice as markdown files with frontmatter. Built-in skills ship with the app;
 * user skills live in the data directory and override built-ins with the same id.
 */
export class SkillLibrary {
  constructor(
    private readonly builtinDir: string,
    private readonly userDir: string,
  ) {}

  private async readDir(dir: string, source: Skill['source']): Promise<Skill[]> {
    const files = await readdir(dir).catch(() => [] as string[]);
    const skills: Skill[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith('.md')) continue;
      const id = file.slice(0, -3);
      const text = await readOptional(path.join(dir, file));
      if (text !== null) skills.push(parseSkill(id, text, source));
    }
    return skills;
  }

  async all(): Promise<Skill[]> {
    const builtin = await this.readDir(this.builtinDir, 'builtin');
    const user = await this.readDir(this.userDir, 'user');
    const byId = new Map<string, Skill>();
    for (const s of builtin) byId.set(s.id, s);
    for (const s of user) byId.set(s.id, { ...s, overridesBuiltin: byId.has(s.id) });
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async list(audience?: AgentName): Promise<SkillMeta[]> {
    const skills = await this.all();
    return skills
      .filter((s) => !audience || s.audience.includes(audience))
      .map(({ body: _body, ...meta }) => meta);
  }

  async get(id: string): Promise<Skill | null> {
    if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(id)) return null;
    return (await this.all()).find((s) => s.id === id) ?? null;
  }

  /** Skills whose full text is injected into the given agent's system prompt. */
  async autoloaded(audience: AgentName): Promise<Skill[]> {
    return (await this.all()).filter((s) => s.autoload && s.audience.includes(audience));
  }

  async save(input: SkillInput): Promise<Skill> {
    if (!input.name.trim()) throw new SkillError('Skill name is required');
    if (!input.body.trim()) throw new SkillError('Skill content is required');
    const id = assertValidId(input.id?.trim() || slugify(input.name) || 'skill', 'skill id');
    const skill: Omit<Skill, 'source' | 'id'> = {
      name: input.name.trim(),
      description: input.description.trim(),
      audience: input.audience?.length ? input.audience : [...AUDIENCES],
      tags: input.tags ?? [],
      autoload: input.autoload ?? false,
      body: input.body,
    };
    await writeAtomic(path.join(this.userDir, `${id}.md`), serializeSkill(skill));
    const saved = await this.get(id);
    if (!saved) throw new SkillError('Failed to save skill');
    return saved;
  }

  /** Deletes a user skill (built-ins are read-only; deleting an override restores the built-in). */
  async delete(id: string): Promise<void> {
    assertValidId(id, 'skill id');
    const file = path.join(this.userDir, `${id}.md`);
    if ((await readOptional(file)) === null) throw new SkillError(`No user skill "${id}" (built-in skills cannot be deleted)`);
    await rm(file);
  }

  /** Compact index for system prompts: id — name: description. */
  async index(audience: AgentName): Promise<string> {
    const skills = (await this.list(audience)).filter((s) => !s.autoload);
    if (!skills.length) return '(no additional skills available)';
    return skills.map((s) => `- ${s.id} — ${s.name}: ${s.description}`).join('\n');
  }
}
