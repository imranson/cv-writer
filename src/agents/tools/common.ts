import { z } from 'zod';
import { evaluateMath } from '../../lib/mathEval.js';
import { defineTool, ToolError } from '../tool.js';

export const evalMath = defineTool({
  name: 'evalMath',
  description:
    'Evaluate an arithmetic expression exactly (e.g. durations, percentages, totals). Supports + - * / % ^, parentheses, pi, e and functions sqrt, abs, round(x, digits), floor, ceil, min, max, sum, avg, pow, exp, ln, log, log2, sin, cos, tan.',
  schema: z.object({
    expression: z.string().min(1).describe('Expression to evaluate, e.g. "(2026 - 2019) * 12 + 4" or "round(37/52*100, 1)"'),
  }),
  async run({ expression }) {
    try {
      return { expression, result: evaluateMath(expression) };
    } catch (err) {
      throw new ToolError(`Could not evaluate "${expression}": ${(err as Error).message}`);
    }
  },
});

export const webSearch = defineTool({
  name: 'webSearch',
  description:
    'Search the web. Use for company research, role expectations, industry terminology or checking current facts. Returns titles, URLs and snippets.',
  schema: z.object({
    query: z.string().min(2).describe('Search query'),
    maxResults: z.number().int().min(1).max(10).optional().describe('Number of results (default 5)'),
  }),
  async run({ query, maxResults }, ctx) {
    const results = await ctx.services.web.search(query, maxResults ?? 5);
    return { query, results };
  },
});

export const webFetch = defineTool({
  name: 'webFetch',
  description:
    'Fetch a public web page (e.g. a job advert URL the user shared, a company "about" page) and return its readable text.',
  schema: z.object({
    url: z.string().url().describe('Absolute http(s) URL'),
  }),
  async run({ url }, ctx) {
    try {
      const page = await ctx.services.web.fetch(url);
      return { url: page.url, title: page.title, content: page.content, links: page.links?.slice(0, 15) };
    } catch (err) {
      throw new ToolError(`Could not fetch ${url}: ${(err as Error).message}`);
    }
  },
});

export const loadSkill = defineTool({
  name: 'loadSkill',
  description:
    'Load the full instructions of one of your skills (listed under "Skills" in your instructions) before doing a task it covers. Pass `file` to load one of the bundled reference files the skill mentions.',
  schema: z.object({
    name: z.string().min(1).describe('Skill name exactly as listed'),
    file: z.string().optional().describe('Optional bundled file path inside the skill, e.g. "references/schema.md"'),
  }),
  async run({ name, file }, ctx) {
    try {
      return await ctx.services.skills.load(ctx.agent, name, file);
    } catch (err) {
      throw new ToolError((err as Error).message);
    }
  },
});

export const COMMON_TOOLS = [evalMath, webSearch, webFetch];
