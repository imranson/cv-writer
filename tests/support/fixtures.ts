import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRuntime } from '../../src/agents/runtime.js';
import type { Config } from '../../src/config.js';
import type { LLM } from '../../src/llm/types.js';
import { Workspace } from '../../src/storage/workspace.js';
import type { FetchedPage, SearchResult, WebClient } from '../../src/tools/webClient.js';
import type { ToolContext } from '../../src/tools/tool.js';
import type { AgentEvent } from '../../src/agents/events.js';

export const SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');

export async function tempDir(prefix = 'cvw-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export class FakeWeb implements WebClient {
  searchEnabled = true;
  searches: string[] = [];
  fetches: string[] = [];
  async search(query: string, maxResults: number): Promise<SearchResult[]> {
    this.searches.push(query);
    return [{ title: `Result for ${query}`, url: 'https://example.com/1', content: 'Example content' }].slice(0, maxResults);
  }
  async fetch(url: string): Promise<FetchedPage> {
    this.fetches.push(url);
    return { url, title: 'Senior Engineer – Acme', content: 'We need TypeScript and Node.js experience.', source: 'direct' };
  }
}

export const testConfig = (overrides: Partial<Config> = {}): Config => ({
  port: 0,
  dataDir: '',
  skillsDir: SKILLS_DIR,
  ollamaHost: 'http://127.0.0.1:1',
  models: { coordinator: 'coord-model', writer: 'writer-model', critic: 'critic-model' },
  maxAgentSteps: 12,
  ...overrides,
});

export function makeRuntime(llm: LLM, workspace: Workspace, overrides: Partial<Config> = {}, web: WebClient = new FakeWeb()) {
  return new AgentRuntime({
    config: testConfig({ dataDir: workspace.dataDir, ...overrides }),
    llm,
    workspace,
    web,
    now: () => new Date('2026-10-11T14:30:00Z'),
    timeZone: 'Europe/London',
  });
}

export function toolContext(events: AgentEvent[] = []): ToolContext {
  return { agent: 'coordinator', depth: 0, emit: (e) => events.push(e) };
}
