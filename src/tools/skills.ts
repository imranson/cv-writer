import { z } from 'zod';
import { findSkill, listSkillFiles, readSkillFile } from '../skills/loader.js';
import { defineTool, type Tool } from './tool.js';

/** Loads one of the calling agent's skills (listed by name in its system prompt), or a file bundled with it. */
export function loadSkillTool(skillsDir: string): Tool {
  return defineTool({
    name: 'loadSkill',
    description:
      'Load the full instructions (SKILL.md) of one of your skills, by the name listed under Skills in your system prompt. ' +
      'The result lists files bundled with the skill (references/, assets/, scripts/); read one by calling again with its path in `file`.',
    schema: z.object({
      name: z.string().min(1).describe('Skill name'),
      file: z.string().min(1).optional().describe('Path of a bundled file relative to the skill, e.g. "references/guide.md". Omit for SKILL.md'),
    }),
    run: async ({ name, file }, ctx) => {
      const skill = await findSkill(skillsDir, ctx.agent, name);
      if (file) return readSkillFile(skill, file);
      const files = await listSkillFiles(skill);
      const bundled = files.length ? `\n\n## Bundled files\n${files.map((f) => `- ${f}`).join('\n')}` : '';
      return `# Skill: ${skill.name}\n\n${skill.content}${bundled}`;
    },
  });
}
