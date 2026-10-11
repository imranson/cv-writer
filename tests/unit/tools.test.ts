import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AgentEvent } from '../../src/agents/events.js';
import { Workspace } from '../../src/storage/workspace.js';
import { cvTools, jobTools, profileTools } from '../../src/tools/data.js';
import { defineTool, executeToolCall, jsonish, MAX_TOOL_OUTPUT, toToolSchema, type Tool } from '../../src/tools/tool.js';
import { tempDir, toolContext } from '../support/fixtures.js';

let dir: string;
let cleanup: () => Promise<void>;
let ws: Workspace;
let events: AgentEvent[];
beforeEach(async () => {
  ({ dir, cleanup } = await tempDir());
  ws = new Workspace(dir);
  events = [];
});
afterEach(() => cleanup());

async function run(tool: Tool, args: unknown) {
  const outcome = await executeToolCall([tool], { function: { name: tool.name, arguments: args as Record<string, unknown> } }, toolContext(events));
  let data;
  try {
    data = outcome.ok ? JSON.parse(outcome.output) : undefined;
  } catch {
    data = undefined;
  }
  return { ...outcome, data };
}

describe('tool framework', () => {
  const echo = defineTool({
    name: 'echo',
    description: 'Echo',
    schema: z.object({ text: z.string(), items: jsonish(z.array(z.number())).optional() }),
    run: async (args) => args,
  });

  it('produces Ollama tool schemas from zod', () => {
    const schema = toToolSchema(echo);
    expect(schema.type).toBe('function');
    expect(schema.function.name).toBe('echo');
    expect(schema.function.parameters).toMatchObject({
      type: 'object',
      properties: { text: { type: 'string' }, items: { type: 'array', items: { type: 'number' } } },
      required: ['text'],
    });
    expect(schema.function.parameters).not.toHaveProperty('$schema');
  });

  it('accepts JSON-string arguments and JSON-string nested values', async () => {
    expect((await run(echo, '{"text":"hi","items":"[1,2]"}')).data).toEqual({ text: 'hi', items: [1, 2] });
  });

  it('treats top-level nulls as omitted optional parameters', async () => {
    expect((await run(echo, { text: 'hi', items: null })).data).toEqual({ text: 'hi' });
    expect((await run(echo, { text: null })).output).toContain('invalid arguments for echo: text:');
  });

  it('turns failures into error text instead of throwing', async () => {
    expect((await run(echo, { nope: 1 })).output).toMatch(/^Error: invalid arguments for echo: text:/);
    expect((await run(echo, '{bad json')).output).toBe('Error: tool arguments were not valid JSON');
    const unknown = await executeToolCall([echo], { function: { name: 'nope', arguments: {} } }, toolContext());
    expect(unknown).toMatchObject({ ok: false, output: 'Error: unknown tool "nope". Available tools: echo' });
    const boom = defineTool({ name: 'boom', description: '', schema: z.object({}), run: async () => { throw new Error('kaput'); } });
    expect((await run(boom, {})).output).toBe('Error: kaput');
  });

  it('truncates huge outputs', async () => {
    const big = defineTool({ name: 'big', description: '', schema: z.object({}), run: async () => 'x'.repeat(MAX_TOOL_OUTPUT + 50) });
    const out = (await run(big, {})).output;
    expect(out.length).toBeLessThan(MAX_TOOL_OUTPUT + 100);
    expect(out).toContain('[truncated 50 characters]');
  });
});

describe('profile tools (coordinator)', () => {
  it('writeProfile creates, readProfile lists and reads, editProfile edits', async () => {
    const { readProfile, writeProfile, editProfile } = profileTools(ws);
    const created = (await run(writeProfile, { profile: { name: 'Ada Lovelace', skills: ['Maths'] } })).data;
    expect(created.id).toMatch(/^profile-ada-lovelace-/);
    expect(events).toContainEqual({ type: 'data_changed', kind: 'profile', id: created.id });
    expect((await run(readProfile, {})).data.profiles).toHaveLength(1);
    expect((await run(readProfile, { profileId: created.id })).data.name).toBe('Ada Lovelace');
    expect((await run(readProfile, { profileId: 'profile-nope' })).output).toContain('not found');
    const edited = await run(editProfile, {
      profileId: created.id,
      operations: [{ op: 'append', path: 'skills', value: 'Poetry' }, { op: 'set', path: 'contact.email', value: 'ada@x.com' }],
    });
    expect(edited.output).toBe('OK');
    expect(await ws.getProfile(created.id)).toMatchObject({ skills: ['Maths', 'Poetry'], contact: { email: 'ada@x.com' } });
    expect((await run(editProfile, { profileId: created.id, operations: [{ op: 'set', path: 'x' }] })).output).toContain('needs a value');
  });

  it('accepts the profile as a JSON string (some models do this)', async () => {
    const { writeProfile } = profileTools(ws);
    expect((await run(writeProfile, { profileId: 'me', profile: '{"name":"Ada"}' })).data).toMatchObject({ id: 'me', name: 'Ada' });
  });
});

describe('job tools (coordinator, critic)', () => {
  it('writeJob links to a profile; readJob lists/reads; editJob edits; searchJobs searches', async () => {
    const { readJob, writeJob, editJob, searchJobs } = jobTools(ws);
    const job = (await run(writeJob, { profileId: 'p1', job: { title: 'Engineer', company: 'Acme', description: 'Rust and Go' } })).data;
    expect(job).toMatchObject({ profileId: 'p1', title: 'Engineer' });
    expect(events.at(-1)).toEqual({ type: 'data_changed', kind: 'job', id: job.id });
    await run(writeJob, { profileId: 'p2', job: { title: 'Designer' } });
    expect((await run(readJob, {})).data.jobs).toHaveLength(2);
    expect((await run(readJob, { profileId: 'p1' })).data.jobs).toEqual([
      expect.objectContaining({ id: job.id, title: 'Engineer @ Acme', hasCv: false }),
    ]);
    expect((await run(readJob, { jobId: job.id })).data.company).toBe('Acme');
    expect((await run(editJob, { jobId: job.id, operations: [{ op: 'set', path: 'status', value: 'applied' }] })).output).toBe('OK');
    expect((await ws.getJob(job.id))?.status).toBe('applied');
    expect((await run(searchJobs, { query: 'rust' })).data.results).toEqual([expect.objectContaining({ id: job.id })]);
  });
});

describe('CV tools (writer, critic)', () => {
  it('writeCV writes html + preferences (+ css); readCV reads all three; editCV edits; searchCVs searches', async () => {
    const { readCV, writeCV, editCV, searchCVs } = cvTools(ws);
    expect((await run(readCV, { jobId: 'j1' })).data.exists).toBe(false);
    const written = await run(writeCV, { jobId: 'j1', html: '<h1>Ada</h1><p>Kotlin expert</p>', preferences: { tone: 'warm' } });
    expect(written.data).toMatchObject({ ok: true, jobId: 'j1', preferences: { tone: 'warm' } });
    expect(events.at(-1)).toEqual({ type: 'data_changed', kind: 'cv', id: 'j1' });
    const read = (await run(readCV, { jobId: 'j1' })).data;
    expect(read).toMatchObject({ exists: true, html: '<h1>Ada</h1><p>Kotlin expert</p>', preferences: { tone: 'warm' } });
    expect(read.css).toContain('@page');
    const edited = await run(editCV, {
      jobId: 'j1',
      htmlEdits: [{ find: 'Kotlin', replace: 'Kotlin and Java' }],
      cssEdits: [{ find: 'size: A4;', replace: 'size: Letter;' }],
      preferenceOps: [{ op: 'set', path: 'pageSize', value: 'Letter' }],
    });
    expect(edited.output).toBe('OK');
    const after = await ws.getCv('j1');
    expect(after.html).toContain('Kotlin and Java');
    expect(after.css).toContain('size: Letter;');
    expect(after.preferences).toEqual({ tone: 'warm', pageSize: 'Letter' });
    expect((await run(editCV, { jobId: 'j1' })).output).toBe('Error: No edits given');
    expect((await run(editCV, { jobId: 'j1', htmlEdits: [{ find: 'Python', replace: 'x' }] })).output).toContain('not found');
    expect((await run(searchCVs, { query: 'java' })).data.results[0]).toMatchObject({ id: 'j1' });
    expect((await run(writeCV, { jobId: '../../x', html: 'x' })).output).toContain('Invalid jobId');
  });
});
