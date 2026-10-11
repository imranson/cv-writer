import { describe, expect, it } from 'vitest';
import { commonTools } from '../../src/tools/common.js';
import { executeToolCall } from '../../src/tools/tool.js';
import { OllamaWebClient } from '../../src/tools/webClient.js';
import { FakeWeb, toolContext } from '../support/fixtures.js';

type Call = { url: string; init?: RequestInit };

function fakeFetch(routes: Record<string, (init?: RequestInit) => Response>, log: Call[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    log.push({ url, init });
    const handler = routes[url];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(init);
  }) as typeof fetch;
}

const publicLookup = async () => ['93.184.216.34'];

async function runTool(name: string, args: Record<string, unknown>, web = new FakeWeb()) {
  return executeToolCall(commonTools(web), { function: { name, arguments: args } }, toolContext());
}

describe('evalMath tool', () => {
  it('evaluates and reports errors', async () => {
    expect(JSON.parse((await runTool('evalMath', { expression: '(2026-2021)*12 + 3' })).output)).toEqual({
      expression: '(2026-2021)*12 + 3',
      result: 63,
    });
    expect((await runTool('evalMath', { expression: '1/0' })).output).toBe('Error: Division by zero');
  });
});

describe('webSearch tool', () => {
  it('uses the Ollama web search API with the API key', async () => {
    const log: Call[] = [];
    const fetchImpl = fakeFetch(
      {
        'https://ollama.com/api/web_search': () =>
          Response.json({ results: [{ title: 'Acme careers', url: 'https://acme.example/jobs', content: 'Senior TS engineer' }] }),
      },
      log,
    );
    const web = new OllamaWebClient({ apiKey: 'sk-test', fetch: fetchImpl });
    const out = JSON.parse((await runTool('webSearch', { query: 'acme jobs', maxResults: 3 }, web as never)).output);
    expect(out.results).toEqual([{ title: 'Acme careers', url: 'https://acme.example/jobs', content: 'Senior TS engineer' }]);
    expect(JSON.parse(String(log[0].init?.body))).toEqual({ query: 'acme jobs', maxResults: 3 });
    expect(new Headers(log[0].init?.headers).get('authorization')).toBe('Bearer sk-test');
  });

  it('explains clearly when no API key is configured', async () => {
    const web = new OllamaWebClient({});
    expect(web.searchEnabled).toBe(false);
    expect((await runTool('webSearch', { query: 'x' }, web as never)).output).toContain('OLLAMA_API_KEY is not configured');
  });
});

describe('webFetch tool', () => {
  it('uses the Ollama web fetch API when a key is configured', async () => {
    const fetchImpl = fakeFetch({
      'https://ollama.com/api/web_fetch': () =>
        Response.json({ title: 'Job', url: 'https://acme.example/job', content: 'Requirements: TypeScript', links: ['https://acme.example'] }),
    });
    const web = new OllamaWebClient({ apiKey: 'k', fetch: fetchImpl });
    const out = JSON.parse((await runTool('webFetch', { url: 'https://acme.example/job' }, web as never)).output);
    expect(out).toMatchObject({ title: 'Job', content: 'Requirements: TypeScript', links: ['https://acme.example'] });
  });

  it('falls back to a direct fetch, following safe redirects and converting HTML to text', async () => {
    const fetchImpl = fakeFetch({
      'https://acme.example/old': () => new Response(null, { status: 301, headers: { location: '/job' } }),
      'https://acme.example/job': () =>
        new Response('<html><head><title>Senior Engineer</title></head><body><h1>Senior Engineer</h1><p>TypeScript &amp; Node</p></body></html>', {
          headers: { 'content-type': 'text/html' },
        }),
    });
    const web = new OllamaWebClient({ fetch: fetchImpl, lookup: publicLookup });
    const out = JSON.parse((await runTool('webFetch', { url: 'https://acme.example/old' }, web as never)).output);
    expect(out).toMatchObject({ url: 'https://acme.example/job', title: 'Senior Engineer' });
    expect(out.content).toContain('TypeScript & Node');
  });

  it('refuses private network targets, including via redirects', async () => {
    const fetchImpl = fakeFetch({
      'https://acme.example/redirect': () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:11434/api/tags' } }),
    });
    const web = new OllamaWebClient({ fetch: fetchImpl, lookup: publicLookup });
    expect((await runTool('webFetch', { url: 'http://localhost:3000/api/profiles' }, web as never)).output).toContain('local address');
    expect((await runTool('webFetch', { url: 'https://acme.example/redirect' }, web as never)).output).toContain('private network');
    expect((await runTool('webFetch', { url: 'ftp://acme.example/x' }, web as never)).output).toContain('Only http(s)');
  });

  it('reports HTTP errors and unsupported content', async () => {
    const fetchImpl = fakeFetch({
      'https://acme.example/pdf': () => new Response('%PDF', { headers: { 'content-type': 'application/pdf' } }),
    });
    const web = new OllamaWebClient({ fetch: fetchImpl, lookup: publicLookup });
    expect((await runTool('webFetch', { url: 'https://acme.example/missing' }, web as never)).output).toContain('HTTP 404');
    expect((await runTool('webFetch', { url: 'https://acme.example/pdf' }, web as never)).output).toContain('Unsupported content type');
  });

  it('truncates very long pages', async () => {
    const web = new FakeWeb();
    web.fetch = async (url) => ({ url, title: 't', content: 'y'.repeat(30_000), source: 'direct' });
    const out = JSON.parse((await runTool('webFetch', { url: 'https://x.example' }, web)).output);
    expect(out.content.length).toBeLessThan(20_100);
    expect(out.content).toContain('[page truncated]');
  });
});
