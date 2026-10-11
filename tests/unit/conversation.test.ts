import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BusyError, ConversationService, titleFrom, type ServerEvent } from '../../src/agents/conversation.ts';
import { LISTING } from '../support/fixtures.ts';
import { makeEnv, type TestEnv } from '../support/env.ts';
import { call, say, ScriptedModel, waitForAbort } from '../support/scriptedModel.ts';

let env: TestEnv;
let service: ConversationService;

beforeEach(async () => {
  env = await makeEnv();
  service = new ConversationService(env.deps, { compactThreshold: 0.8, keepRecent: 2 });
});
afterEach(() => env.cleanup());

const collect = () => {
  const events: ServerEvent[] = [];
  return { events, emit: (e: ServerEvent) => events.push(e) };
};

describe('ConversationService', () => {
  it('runs a coordinator turn, persisting messages, title and active job', async () => {
    const s = await env.store.createSession();
    env.models.coordinator.push(call('save_job', { title: 'Senior PM', company: 'Brightwave', listing: LISTING }), say('Saved the job. What is your current role?'));
    const { events, emit } = collect();
    const saved = await service.sendMessage(s.id, 'Here is the job listing for Brightwave', emit);

    expect(saved.title).toBe('Here is the job listing for Brightwave');
    expect(saved.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(saved.messages.every((m) => m.id && m.at)).toBe(true);
    expect(saved.jobId).toMatch(/^brightwave-senior-pm-/);
    expect(saved.context).toMatchObject({ estimated: false, limit: 100_000 });
    expect(saved.context.tokens).toBeGreaterThan(0);
    expect(await env.store.requireSession(s.id)).toEqual(saved);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('message');
    expect(types).toContain('tool_start');
    expect(types).toContain('context');
    expect(types.at(-1)).toBe('done');
    expect(events).toContainEqual(expect.objectContaining({ type: 'session', session: expect.objectContaining({ jobId: saved.jobId }) }));
    expect(events.filter((e) => e.type === 'message')).toHaveLength(4);
  });

  it('sends only the post-compaction history plus a state block to the model', async () => {
    const s = await env.store.createSession();
    env.models.coordinator.push(say('First reply'), say('Second reply'));
    await service.sendMessage(s.id, 'one');
    await service.sendMessage(s.id, 'two');
    const req = env.models.coordinator.requests[1]!;
    expect(req.messages[0]!.role).toBe('system');
    expect(req.messages[0]!.content).toContain('# Current state');
    expect(req.messages.slice(1).map((m) => m.content)).toEqual(['one', 'First reply', 'two']);
  });

  it('rejects concurrent turns and supports stopping a running turn', async () => {
    const s = await env.store.createSession();
    env.models.coordinator.push((req) => waitForAbort(req));
    const { events, emit } = collect();
    const running = service.sendMessage(s.id, 'slow', emit);
    await new Promise((r) => setTimeout(r, 20));
    expect(service.isRunning(s.id)).toBe(true);
    await expect(service.sendMessage(s.id, 'again')).rejects.toBeInstanceOf(BusyError);
    expect(service.stop(s.id)).toBe(true);
    await running;
    expect(events.at(-1)).toEqual({ type: 'stopped' });
    expect(service.isRunning(s.id)).toBe(false);
    expect(service.stop(s.id)).toBe(false);
    expect((await env.store.requireSession(s.id)).messages.map((m) => m.content)).toEqual(['slow']);
  });

  it('reports model errors as events and keeps the session usable', async () => {
    const s = await env.store.createSession();
    env.models.coordinator.push(() => {
      throw new Error('model unavailable');
    });
    const { events, emit } = collect();
    await service.sendMessage(s.id, 'hello', emit);
    expect(events.at(-1)).toEqual({ type: 'error', message: 'model unavailable' });
    env.models.coordinator.push(say('Back online'));
    const saved = await service.sendMessage(s.id, 'retry');
    expect(saved.messages.at(-1)?.content).toBe('Back online');
  });

  it('compacts older messages automatically when the context is nearly full', async () => {
    const coordinator = new ScriptedModel([say('a1'), say('a2'), say('Summary: user is Alex'), say('a3')], {
      contextLength: 1000,
      usage: () => ({ promptTokens: 900, completionTokens: 10 }),
    });
    env.deps.models.coordinator = coordinator;
    const s = await env.store.createSession();
    await service.sendMessage(s.id, 'u1');
    await service.sendMessage(s.id, 'u2');
    const { events, emit } = collect();
    const saved = await service.sendMessage(s.id, 'u3', emit);
    expect(events).toContainEqual({ type: 'compacted', compacted: 2 });
    expect(saved.summary).toBe('Summary: user is Alex');
    expect(saved.contextStart).toBe(2);
    const last = coordinator.requests.at(-1)!;
    expect(last.messages[0]!.content).toContain('Summary: user is Alex');
    expect(last.messages.slice(1).map((m) => m.content)).toEqual(['u2', 'a2', 'u3']);
  });

  it('compacts on demand and estimates usage before the model reports any', async () => {
    const s = await env.store.createSession();
    const usage = await service.contextUsage(s);
    expect(usage.estimated).toBe(true);
    expect(usage.tokens).toBeGreaterThan(500); // the system prompt alone is substantial
    expect(usage.limit).toBe(100_000);
    env.models.coordinator.push(say('a1'), say('a2'), say('a3'), say('Short summary'));
    for (const t of ['u1', 'u2', 'u3']) await service.sendMessage(s.id, t);
    const compacted = await service.compact(s.id);
    expect(compacted.summary).toBe('Short summary');
    expect(compacted.contextStart).toBe(4);
  });

  it('derives short titles', () => {
    expect(titleFrom('  hello\n world ')).toBe('hello world');
    expect(titleFrom('x'.repeat(80))).toHaveLength(58);
    expect(titleFrom('   ')).toBe('New conversation');
  });
});
