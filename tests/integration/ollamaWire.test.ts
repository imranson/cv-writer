import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatService } from '../../src/chat/service.js';
import { OllamaLLM } from '../../src/llm/ollama.js';
import { Workspace } from '../../src/storage/workspace.js';
import { makeRuntime, tempDir } from '../support/fixtures.js';

/** A stand-in Ollama daemon speaking the real /api/chat (NDJSON stream) and /api/show protocol. */
interface WireRequest {
  model: string;
  messages: { role: string; content: string; tool_name?: string; tool_calls?: unknown[] }[];
  tools: { function: { name: string } }[];
  stream: boolean;
}

describe('Ollama wire protocol (fake daemon, real client)', () => {
  let server: Server;
  let host: string;
  const chats: WireRequest[] = [];
  let tmp: { dir: string; cleanup: () => Promise<void> };

  const agentOf = (r: WireRequest) => /You are the (\w+)/.exec(r.messages[0].content)?.[1];

  function reply(r: WireRequest) {
    const agent = agentOf(r);
    const last = r.messages.at(-1)!;
    if (agent === 'Coordinator' && last.role === 'user') {
      return { content: '', tool_calls: [{ function: { name: 'evalMath', arguments: { expression: '2026 - 2019' } } }] };
    }
    if (agent === 'Coordinator' && last.tool_name === 'evalMath') {
      return { content: '', tool_calls: [{ function: { name: 'callCritic', arguments: { jobId: 'job-x' } } }] };
    }
    if (agent === 'Critic') return { content: 'No CV yet for job-x.' };
    return { content: 'You have 7 years of experience; the critic notes there is no CV yet.' };
  }

  beforeAll(async () => {
    tmp = await tempDir();
    server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.url === '/api/show') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ model_info: { 'general.architecture': 'kimi-k2', 'kimi-k2.context_length': 262144 }, details: {} }));
        return;
      }
      if (req.url === '/api/chat') {
        const r = JSON.parse(body) as WireRequest;
        chats.push(r);
        const message = reply(r);
        res.setHeader('content-type', 'application/x-ndjson');
        const words = message.content.split(/(?<= )/);
        for (const w of words) res.write(JSON.stringify({ model: r.model, message: { role: 'assistant', content: w }, done: false }) + '\n');
        if ('tool_calls' in message) {
          res.write(JSON.stringify({ model: r.model, message: { role: 'assistant', content: '', tool_calls: message.tool_calls }, done: false }) + '\n');
        }
        res.end(JSON.stringify({ model: r.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 900, eval_count: 20 }) + '\n');
        return;
      }
      res.statusCode = 404;
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    host = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    server.close();
    await tmp.cleanup();
  });

  it('runs coordinator + critic over the Ollama API with tools, system info and tool results on the wire', async () => {
    const ws = new Workspace(tmp.dir);
    const runtime = makeRuntime(new OllamaLLM({ host }), ws);
    const chat = new ChatService(runtime, ws);
    const session = await chat.create();
    const events: any[] = [];
    await chat.send(session.id, 'How many years since 2019?', (e) => events.push(e));

    expect(events.at(-1)).toEqual({ type: 'done', text: 'You have 7 years of experience; the critic notes there is no CV yet.' });
    expect(chats.map(agentOf)).toEqual(['Coordinator', 'Coordinator', 'Critic', 'Coordinator']);
    expect(chats.map((c) => c.model)).toEqual(['coord-model', 'coord-model', 'critic-model', 'coord-model']);
    expect(chats.every((c) => c.stream)).toBe(true);

    // tool definitions per agent
    expect(chats[0].tools.map((t) => t.function.name)).toContain('callWriter');
    expect(chats[2].tools.map((t) => t.function.name).sort()).toEqual(
      ['evalMath', 'loadSkill', 'readCV', 'readJob', 'searchCVs', 'searchJobs', 'webFetch', 'webSearch'].sort(),
    );

    // system information on every request, with the context window read from /api/show
    for (const c of chats) {
      expect(c.messages[0].role).toBe('system');
      expect(c.messages[0].content).toContain('Current date and time:');
      expect(c.messages[0].content).toMatch(/Context window: [\d,]+ \/ 262,144 tokens used/);
    }
    // after the first response the model-reported usage (900 + 20) is the base
    expect(chats[1].messages[0].content).toMatch(/Context window: 9[2-9]\d \/ 262,144/);

    // tool results go back as role "tool" with tool_name
    const toolMsg = chats[1].messages.at(-1)!;
    expect(toolMsg).toMatchObject({ role: 'tool', tool_name: 'evalMath' });
    expect(JSON.parse(toolMsg.content)).toEqual({ expression: '2026 - 2019', result: 7 });
    expect(chats[3].messages.at(-1)).toMatchObject({ role: 'tool', tool_name: 'callCritic' });
    expect(chats[3].messages.at(-1)!.content).toContain('No CV yet for job-x.');

    const ctx = events.filter((e) => e.type === 'context' && e.depth === 0).at(-1);
    expect(ctx.contextWindow).toBe(262144);
  });
});
