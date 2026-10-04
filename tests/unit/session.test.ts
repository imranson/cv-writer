import { describe, expect, it } from 'vitest';
import { Agent } from '../../src/agents/agent.js';
import { NEW_SESSION_KICKOFF, RESUME_KICKOFF } from '../../src/agents/prompts.js';
import { presentEvents, runConversation, startSession } from '../../src/app/session.js';
import { LlmError } from '../../src/llm/ollama.js';
import { sampleCv, sampleJob, seedProfile, tempStore } from '../helpers.js';
import { byModel, call, say, ScriptedIO, ScriptedModel, type Step } from '../support/scripted.js';

function coordinator(steps: Step[]) {
  const model = new ScriptedModel(steps);
  const agent = new Agent({ name: 'coordinator', model: 'c', client: model, systemPrompt: 'sys', tools: [], onEvent: () => {} });
  return { agent, model };
}

describe('runConversation', () => {
  it('kicks off, then feeds each user reply to the coordinator until /quit', async () => {
    const { agent, model } = coordinator([say('Welcome!'), say('Nice.')]);
    const io = new ScriptedIO(['I am a developer', ' /QUIT ']);
    const saves: number[] = [];
    const summary = await runConversation({ io, coordinator: agent, sessionId: 's1', afterTurn: async () => void saves.push(agent.messages.length) });

    expect(model.requests.map((r) => r.messages.at(-1)!.content)).toEqual([NEW_SESSION_KICKOFF, 'I am a developer']);
    expect(summary).toEqual({ sessionId: 's1', turns: 2, usage: { requests: 2, promptTokens: 200, outputTokens: 40 }, endedBy: 'user' });
    expect(saves).toEqual([2, 4]);
  });

  it('uses a custom kickoff and ends at end of input', async () => {
    const { agent, model } = coordinator([say('Welcome back')]);
    const summary = await runConversation({ io: new ScriptedIO([null]), coordinator: agent, sessionId: 's', kickoff: 'back again' });
    expect(model.requests[0]!.messages.at(-1)!.content).toBe('back again');
    expect(summary.endedBy).toBe('user');
  });

  it('reports recoverable errors and lets the user carry on', async () => {
    const { agent } = coordinator([
      () => {
        throw new LlmError('Ollama request failed (503): overloaded', false, 503);
      },
      say('Back now.'),
    ]);
    const io = new ScriptedIO(['try again', null]);
    const summary = await runConversation({ io, coordinator: agent, sessionId: 's' });
    expect(io.statuses).toEqual(['Something went wrong: Ollama request failed (503): overloaded. Everything saved so far is kept; you can try again.']);
    expect(summary).toMatchObject({ turns: 2, endedBy: 'user' });
  });

  it('ends the session on fatal model errors without asking for input', async () => {
    const { agent } = coordinator([
      () => {
        throw new LlmError('Run `ollama signin`', true, 401);
      },
    ]);
    const io = new ScriptedIO(['never read']);
    let saved = 0;
    const summary = await runConversation({ io, coordinator: agent, sessionId: 's', afterTurn: async () => void saved++ });
    expect(summary).toMatchObject({ endedBy: 'error', error: 'Run `ollama signin`', turns: 0 });
    expect(io.reads).toBe(0);
    expect(io.statuses).toEqual(['Run `ollama signin`']);
    expect(saved).toBe(1);
  });

  it('tells the user when a turn hit the step limit or produced nothing', async () => {
    const model = new ScriptedModel([call('nothing'), say(''), say('')]);
    const agent = new Agent({ name: 'coordinator', model: 'c', client: model, systemPrompt: 's', tools: [], maxSteps: 1 });
    const io = new ScriptedIO(['hello', null]);
    await runConversation({ io, coordinator: agent, sessionId: 's' });
    expect(io.statuses).toEqual([
      'That took more steps than expected, so I paused. Say "continue" to carry on.',
      '(No reply from the model. Try rephrasing, or say "continue".)',
    ]);
  });
});

describe('presentEvents', () => {
  it('shows coordinator text, labels tool calls and hides writer text', () => {
    const io = new ScriptedIO();
    const present = presentEvents(io);
    present({ type: 'text', agent: 'coordinator', text: 'Hello' });
    present({ type: 'text', agent: 'cv-writer', text: 'internal notes' });
    present({ type: 'tool-call', agent: 'coordinator', name: 'get_profile', args: {} });
    present({ type: 'tool-call', agent: 'cv-writer', name: 'save_cv_version', args: {} });
    present({ type: 'tool-call', agent: 'coordinator', name: 'unlabelled_tool', args: {} });
    present({
      type: 'tool-result',
      agent: 'cv-writer',
      name: 'save_cv_version',
      ok: true,
      output: JSON.stringify({ version: 2, verificationPassed: true, issues: [{ severity: 'warning' }] }),
    });
    expect(io.said).toEqual(['Hello']);
    expect(io.statuses).toEqual([
      'Reading your profile',
      'cv-writer: Saving a draft and running checks',
      'cv-writer: saved version 2 (checks passed with 1 warning)',
    ]);
  });
});

describe('startSession', () => {
  it('wires the coordinator to the cv-writer and saves the conversation after every turn', async () => {
    const store = await tempStore();
    await seedProfile(store);
    const job = await store.saveJob(sampleJob());
    const coordinatorModel = new ScriptedModel([
      say('Hi Alex! Shall I draft a CV for the Acme role?'),
      call('write_cv', { jobId: job.id }),
      say('Here it is. All checks passed.'),
    ]);
    const writerModel = new ScriptedModel([call('save_cv_version', { document: sampleCv(), changeSummary: 'First draft' }), say('Saved v1.')]);
    const io = new ScriptedIO(['Yes please', '/quit']);

    const summary = await startSession({
      store,
      io,
      client: byModel({ coord: coordinatorModel, writer: writerModel }),
      model: 'coord',
      writerModel: 'writer',
      think: 'low',
      today: 'Sun Oct 04 2026',
    });

    expect(io.said).toEqual(['Hi Alex! Shall I draft a CV for the Acme role?', 'Here it is. All checks passed.']);
    expect(io.shown.map((v) => v.version)).toEqual([1]);
    expect(io.statuses).toContain('cv-writer: saved version 1 (checks passed)');
    expect(writerModel.requests[0]!.think).toBe('low');
    expect(summary).toMatchObject({ turns: 2, endedBy: 'user', usage: { requests: 5 } });

    const session = (await store.getSession(summary.sessionId))!;
    expect(session).toMatchObject({ model: 'coord', writerModel: 'writer', usage: summary.usage });
    expect(session.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'tool', 'assistant']);
    expect((await store.listWriterRuns())[0]).toMatchObject({ sessionId: summary.sessionId, savedVersions: [1] });
  });

  it('resumes a saved conversation by id or as the latest one', async () => {
    const store = await tempStore();
    const first = new ScriptedModel([say('Welcome!')]);
    const { sessionId } = await startSession({ store, io: new ScriptedIO(['/q']), client: first, model: 'm', writerModel: 'w' });

    const second = new ScriptedModel([say('Welcome back!'), say('Again!')]);
    await startSession({ store, io: new ScriptedIO([null]), client: second, model: 'm', writerModel: 'w', resume: sessionId });
    await startSession({ store, io: new ScriptedIO([null]), client: second, model: 'm', writerModel: 'w', resume: 'latest' });

    expect(second.requests[0]!.messages.slice(1).map((m) => m.content)).toEqual([NEW_SESSION_KICKOFF, 'Welcome!', RESUME_KICKOFF]);
    expect(second.requests[1]!.messages).toHaveLength(6);
    const session = (await store.getSession(sessionId))!;
    expect(session.messages.at(-1)!.content).toBe('Again!');
    expect(session.usage.requests).toBe(3);
  });

  it('refuses to resume something that does not exist', async () => {
    const store = await tempStore();
    const opts = { store, io: new ScriptedIO(), client: new ScriptedModel(), model: 'm', writerModel: 'w' };
    await expect(startSession({ ...opts, resume: 'latest' })).rejects.toThrow('There is no earlier conversation to continue.');
    await expect(startSession({ ...opts, resume: 'session-nope' })).rejects.toThrow('No saved conversation "session-nope".');
  });
});
