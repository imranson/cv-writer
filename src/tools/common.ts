import { z } from 'zod';
import { evaluateMath } from '../lib/math.js';
import { defineTool, type Tool } from './tool.js';
import type { WebClient } from './webClient.js';

const MAX_PAGE_CHARS = 20_000;

/** Tools every agent gets: evalMath, webSearch, webFetch. */
export function commonTools(web: WebClient): Tool[] {
  return [
    defineTool({
      name: 'evalMath',
      description:
        'Evaluate an arithmetic expression exactly (never do maths in your head). Supports + - * / % ^, parentheses, ' +
        'pi, e and functions abs, sqrt, round(x, digits), floor, ceil, min, max, pow, log(x[, base]), ln, exp. ' +
        'Example: "(2026 - 2019) + 4/12".',
      schema: z.object({ expression: z.string().describe('The expression to evaluate') }),
      run: async ({ expression }) => ({ expression, result: evaluateMath(expression) }),
    }),
    defineTool({
      name: 'webSearch',
      description:
        'Search the web. Returns result titles, URLs and content excerpts. Use for job postings, company research, ' +
        'role expectations and CV conventions in a market.',
      schema: z.object({
        query: z.string().min(1).describe('Search query'),
        maxResults: z.number().int().min(1).max(10).optional().describe('Number of results (default 5)'),
      }),
      run: async ({ query, maxResults }) => ({ query, results: await web.search(query, maxResults ?? 5) }),
    }),
    defineTool({
      name: 'webFetch',
      description: 'Fetch a web page (e.g. a job posting URL the user shared) and return its readable text content.',
      schema: z.object({ url: z.string().describe('Absolute http(s) URL') }),
      run: async ({ url }) => {
        const page = await web.fetch(url);
        const truncated = page.content.length > MAX_PAGE_CHARS;
        return {
          url: page.url,
          title: page.title,
          content: truncated ? `${page.content.slice(0, MAX_PAGE_CHARS)}\n…[page truncated]` : page.content,
          ...(page.links?.length ? { links: page.links.slice(0, 30) } : {}),
        };
      },
    }),
  ];
}
