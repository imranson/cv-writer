import { z } from 'zod';
import { evaluate } from '../../lib/math.js';
import { webFetch as fetchPage, webSearch as searchWeb } from '../../lib/web.js';
import { defineTool, ToolError } from './types.js';

export const evalMath = defineTool({
  name: 'evalMath',
  description:
    'Evaluate an arithmetic expression exactly (use instead of mental maths): + - * / % ^, parentheses, pi, e, ' +
    'sqrt, abs, round(x, digits), floor, ceil, min, max, sum, avg, log(x[, base]), ln, exp, sin/cos/tan. ' +
    'E.g. durations, percentages, word budgets.',
  schema: z.object({ expression: z.string().min(1).describe('e.g. "round((2026-2019) + 7/12, 1)"') }),
  async run({ expression }) {
    try {
      return { expression, result: evaluate(expression) };
    } catch (err) {
      throw new ToolError(`Cannot evaluate "${expression}": ${(err as Error).message}`);
    }
  },
});

export const webSearch = defineTool({
  name: 'webSearch',
  description: 'Search the web. Returns titles, URLs and snippets — e.g. company research, role expectations, industry keywords.',
  schema: z.object({
    query: z.string().min(1),
    maxResults: z.number().int().min(1).max(10).optional().describe('Default 5.'),
  }),
  async run({ query, maxResults }, ctx) {
    const results = await searchWeb(query, maxResults ?? 5, ctx.web);
    return { query, results };
  },
});

export const webFetch = defineTool({
  name: 'webFetch',
  description: 'Fetch a public web page (e.g. a job posting URL) and return its readable text content and links.',
  schema: z.object({
    url: z.string().min(1).describe('Absolute http(s) URL.'),
    maxChars: z.number().int().min(500).max(50_000).optional().describe('Max characters of text to return (default 15000).'),
  }),
  async run({ url, maxChars }, ctx) {
    try {
      return await fetchPage(url, { ...ctx.web, maxChars: maxChars ?? 15_000 });
    } catch (err) {
      throw new ToolError(`Could not fetch ${url}: ${(err as Error).message}`);
    }
  },
});

export const loadSkill = defineTool({
  name: 'loadSkill',
  description:
    'Load one of your skills (packaged expert instructions listed in your system prompt) by name. ' +
    'Optionally pass `file` to load a bundled resource the skill refers to (e.g. "references/rubric.md").',
  schema: z.object({
    name: z.string().min(1).describe('Skill name, e.g. "cv-intake-interview".'),
    file: z.string().optional().describe('Path of a file inside the skill folder.'),
  }),
  async run({ name, file }, ctx) {
    try {
      const { skill, content } = await ctx.skills.load(ctx.agent, name, file);
      if (!file) ctx.emit({ type: 'skill_loaded', runId: ctx.runId, skill: name });
      return [
        `# Skill: ${skill.name}${file ? ` — ${file}` : ''}`,
        content,
        !file && skill.files.length ? `\n(Bundled files you can load with loadSkill {name, file}: ${skill.files.join(', ')})` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  },
});
