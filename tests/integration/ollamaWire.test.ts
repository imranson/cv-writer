import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../../src/agents/agent.js';
import { runTurn } from '../../src/agents/coordinator.js';
import { OllamaChatModel } from '../../src/llm/ollama.js';
import type { Store } from '../../src/storage/store.js';
import { seededStore, tempDir } from '../support/fixtures.js';

/** A stand-in Ollama server speaking the real /api/chat wire format (NDJSON when streaming). */
type Chunk = { content?: string; thinking?: string; tool_calls?: unknown[] };
const replies: Chunk[][] = [];
const received: Array<Record<string, unknown>> = [];
let url = '';
let close: () => Promise<void>;

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const c of req) raw += c;
  return JSON.parse(raw) as Record<string, unknown>;
}

beforeAll(async () => {
  const server = createServer(async (req, res) => {
    if (req.url !== '/api/chat') {
      res.writeHead(404).end(JSON.stringify({ error: 'not found' }));
      return;
    }
    const request = await body(req);
    received.push(request);
    const chunks = replies.shift();
    if (!chunks) {
      res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'no reply scripted' }));
      return;
    }
    const final = { model: request.model, created_at: new Date().toISOString(), done: true, done_reason: 'stop', prompt_eval_count: 50, eval_count: 5 };
    if (request.stream === false) {
      const merged = chunks.reduce<Chunk>((m, c) => ({ content: (m.content ?? '') + (c.content ?? ''), tool_calls: [...(m.tool_calls ?? []), ...(c.tool_calls ?? [])] }), {});
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...final, message: { role: 'assistant', ...merged } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    for (const c of chunks) res.write(`${JSON.stringify({ model: request.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...c }, done: false })}\n`);
    res.end(`${JSON.stringify({ ...final, message: { role: 'assistant', content: '' } })}\n`);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});
afterAll(() => close());

describe('coordinator over the Ollama wire protocol', () => {
  let store: Store;
  let cleanup: () => Promise<void>;
  beforeAll(async () => {
    const t = await tempDir();
    cleanup = t.cleanup;
    ({ store } = await seededStore(t.dir));
  });
  afterAll(() => cleanup());

  it('streams, calls tools from the wire format, and strips leaked reasoning', async () => {
    replies.push(
      [{ thinking: 'The user speaks French; save it.' }, { content: '', tool_calls: [{ function: { name: 'add_facts', arguments: { facts: ['Speaks French'], reason: null } } }] }],
      [{ content: 'I should be brief.</think>' }, { content: 'Saved! ' }, { content: 'What is your notice period?' }],
    );
    const session = await store.createSession();
    const events: AgentEvent[] = [];
    const llm = new OllamaChatModel({ host: url, sleep: async () => undefined });
    const { reply } = await runTurn({ store, llm, models: { coordinator: 'glm-5.3:cloud', writer: 'w', critic: 'c' }, think: { coordinator: 'low' } }, session.id, { text: 'I speak French' }, (e) => events.push(e));

    expect(reply).toBe('Saved! What is your notice period?');
    expect((await store.getProfile()).facts).toContain('Speaks French');

    const first = received[0]!;
    expect(first).toMatchObject({ model: 'glm-5.3:cloud', stream: true, think: 'low' });
    const messages = first.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('You are the CV coach');
    const tools = first.tools as Array<{ function: { name: string; parameters: { type: string } } }>;
    expect(tools.map((t) => t.function.name)).toEqual(expect.arrayContaining(['add_profile_entry', 'save_job_listing', 'write_cv', 'critique_cv', 'approve_cv', 'update_style']));
    expect(tools.every((t) => t.function.parameters.type === 'object')).toBe(true);

    // The tool result and the reasoning go back to the model in Ollama's format.
    const second = received[1]!.messages as Array<{ role: string; content: string; tool_name?: string; thinking?: string; tool_calls?: unknown[] }>;
    const assistant = second.find((m) => m.role === 'assistant')!;
    expect(assistant.thinking).toBe('The user speaks French; save it.');
    expect(assistant.tool_calls).toHaveLength(1);
    const tool = second.find((m) => m.role === 'tool')!;
    expect(tool.tool_name).toBe('add_facts');
    expect(JSON.parse(tool.content)).toMatchObject({ ok: true });

    expect(events.filter((e) => e.type === 'delta' && e.thinking).length).toBe(1);
    expect(events).toContainEqual({ type: 'state', changed: ['profile'] });
  });

  it('surfaces server errors after retrying', async () => {
    const session = await store.createSession();
    const llm = new OllamaChatModel({ host: url, sleep: async () => undefined, retries: 1 });
    const before = received.length;
    await expect(runTurn({ store, llm, models: { coordinator: 'm', writer: 'w', critic: 'c' } }, session.id, { text: 'hi' }, () => undefined)).rejects.toThrow(/Ollama error: no reply scripted/);
    expect(received.length - before).toBe(2);
  });
});
