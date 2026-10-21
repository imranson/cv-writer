import { z } from 'zod';
import { evaluateMath } from '../../util/mathEval';
import { truncate } from '../../util/text';
import { defineTool } from '../types';

const WEB_CONTENT_LIMIT = 12_000;

export const evalMath = defineTool({
  name: 'evalMath',
  description:
    'Evaluate an arithmetic expression exactly (e.g. dates, durations, percentages, word budgets). ' +
    'Supports + - * / % ^, parentheses, pi, e and functions sqrt, abs, round(x, digits), floor, ceil, min, max, sum, avg, log, ln, exp, pow.',
  schema: z.object({ expression: z.string().describe('Expression to evaluate, e.g. "(2026 - 2019) * 12 + 4"') }),
  async run({ expression }) {
    return { expression, result: evaluateMath(expression) };
  },
});

export const webSearch = defineTool({
  name: 'webSearch',
  description: 'Search the web. Returns titles, URLs and page excerpts. Use for company research, role expectations or industry terminology.',
  schema: z.object({
    query: z.string().min(1).describe('Search query'),
    maxResults: z.coerce.number().int().min(1).max(10).optional().describe('Number of results (1-10, default 5)'),
  }),
  async run({ query, maxResults }, ctx) {
    const results = await ctx.deps.web.search(query, maxResults ?? 5);
    return { query, results: results.map((r) => ({ ...r, content: truncate(r.content, 2_000) })) };
  },
});

export const webFetch = defineTool({
  name: 'webFetch',
  description: 'Fetch a web page (e.g. a job posting URL) and return its readable text, title and links.',
  schema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
  async run({ url }, ctx) {
    const page = await ctx.deps.web.fetch(url);
    return { title: page.title, url: page.url, content: truncate(page.content, WEB_CONTENT_LIMIT), links: page.links.slice(0, 30) };
  },
});

export const loadSkill = defineTool({
  name: 'loadSkill',
  description:
    'Load one of your skills (listed under "Skills" in your instructions) to get its full instructions. ' +
    'Pass `file` to read a bundled reference file the skill mentions.',
  schema: z.object({
    name: z.string().describe('Skill name'),
    file: z.string().optional().describe('Optional file inside the skill folder, e.g. "references/template.html"'),
  }),
  async run({ name, file }, ctx) {
    const skill = await ctx.deps.skills.load(ctx.agent, name, file);
    return { name: skill.name, file: skill.file, content: skill.content, bundledFiles: skill.files };
  },
});
