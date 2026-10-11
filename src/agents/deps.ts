import type { PdfService } from '../cv/pdf.ts';
import type { ChatModel } from '../llm/types.ts';
import type { SkillLibrary } from '../skills/library.ts';
import type { Store } from '../storage/store.ts';
import type { FetchedPage } from '../util/fetchPage.ts';

export interface AgentModels {
  coordinator: ChatModel;
  writer: ChatModel;
  critic: ChatModel;
}

/** Everything the agents need from the outside world; swapped for fakes in tests. */
export interface AgentDeps {
  store: Store;
  skills: SkillLibrary;
  models: AgentModels;
  /** Used for page counts and PDF export. Optional so agents still work without a browser. */
  pdf?: PdfService;
  fetchPage?: (url: string) => Promise<FetchedPage>;
  now?: () => Date;
}
