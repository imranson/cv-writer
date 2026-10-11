import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentDeps, AgentModels } from '../../src/agents/deps.ts';
import type { PdfService, RenderedPdf } from '../../src/cv/pdf.ts';
import { SkillLibrary } from '../../src/skills/library.ts';
import { Store } from '../../src/storage/store.ts';
import type { FetchedPage } from '../../src/util/fetchPage.ts';
import { ScriptedModel } from './scriptedModel.ts';

export const BUILTIN_SKILLS_DIR = path.resolve(import.meta.dirname, '../../skills');

export async function tempDir(prefix = 'cvw-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** PDF service double: no browser, fixed page count, records rendered documents. */
export class FakePdf implements PdfService {
  readonly rendered: string[] = [];
  constructor(public pageCount = 1) {}
  async render(documentHtml: string): Promise<RenderedPdf> {
    this.rendered.push(documentHtml);
    return { pdf: Buffer.from('%PDF-1.4\n% fake\n'), pageCount: this.pageCount };
  }
  async close(): Promise<void> {}
}

export interface TestEnv {
  dir: string;
  deps: AgentDeps;
  store: Store;
  skills: SkillLibrary;
  models: { coordinator: ScriptedModel; writer: ScriptedModel; critic: ScriptedModel };
  pdf: FakePdf;
  cleanup: () => Promise<void>;
}

export async function makeEnv(opts: { models?: Partial<AgentModels>; fetchPage?: (url: string) => Promise<FetchedPage> } = {}): Promise<TestEnv> {
  const { dir, cleanup } = await tempDir();
  const store = new Store(dir);
  await store.init();
  const skills = new SkillLibrary(BUILTIN_SKILLS_DIR, path.join(dir, 'skills'));
  const models = {
    coordinator: new ScriptedModel([], { name: 'coordinator' }),
    writer: new ScriptedModel([], { name: 'writer' }),
    critic: new ScriptedModel([], { name: 'critic' }),
  };
  const pdf = new FakePdf();
  const deps: AgentDeps = {
    store,
    skills,
    models: { ...models, ...opts.models },
    pdf,
    fetchPage: opts.fetchPage,
    now: () => new Date('2026-10-10T12:00:00Z'),
  };
  return { dir, deps, store, skills, models, pdf, cleanup };
}
