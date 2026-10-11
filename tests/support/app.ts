import { ChatService } from '../../src/chat/service.js';
import { PlaywrightPdfRenderer, type PdfRenderer } from '../../src/cv/pdf.js';
import type { LLM } from '../../src/llm/types.js';
import { createApp } from '../../src/server/app.js';
import { createClientBundler } from '../../src/server/clientBundle.js';
import { Workspace } from '../../src/storage/workspace.js';
import { readEventStream } from '../../src/client/sse.js';
import type { ChatEvent } from '../../src/chat/service.js';
import { makeRuntime, tempDir } from './fixtures.js';

export async function buildTestApp(llm: LLM, pdf: PdfRenderer = new PlaywrightPdfRenderer()) {
  const { dir, cleanup } = await tempDir();
  const workspace = new Workspace(dir);
  const runtime = makeRuntime(llm, workspace);
  const chat = new ChatService(runtime, workspace);
  const app = createApp({
    workspace,
    chat,
    pdf,
    clientBundle: createClientBundler(),
    status: async () => ({ models: { coordinator: 'coord-model' }, contextWindow: await runtime.contextWindow('coordinator'), webSearch: true }),
  });
  return {
    app,
    workspace,
    chat,
    dir,
    cleanup: async () => {
      await pdf.close();
      await cleanup();
    },
  };
}

export async function collectEvents(response: Response): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  await readEventStream<ChatEvent>(response, (e) => events.push(e));
  return events;
}
