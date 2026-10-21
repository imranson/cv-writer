import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { AGENT_TOOLS, ALL_TOOLS, coerceArgs, executeTool, toOllamaTool } from '../../src/agents/tools';
import type { EmitInput, ToolContext } from '../../src/agents/types';
import type { AgentName } from '../../src/config';
import { DEFAULT_PREFERENCES } from '../../src/store';
import { FakeWeb, makeDeps, tempDir } from '../helpers';

let tmp: Awaited<ReturnType<typeof tempDir>>;
let events: EmitInput[];
let spawn: Mock<(agent: AgentName, task: string) => Promise<string>>;
let ctxFor: (agent: AgentName) => ToolContext;

beforeEach(async () => {
  tmp = await tempDir();
  const deps = makeDeps(tmp.dir);
  events = [];
  spawn = vi.fn<(agent: AgentName, task: string) => Promise<string>>(async (agent, task) => `${agent} report for: ${task.slice(0, 40)}`);
  ctxFor = (agent) => ({ deps, userId: 'u1', agent, runId: 'r1', emit: (e) => events.push(e), spawn });
});
afterEach(() => tmp.cleanup());

async function call(agent: AgentName, name: string, args: unknown) {
  const out = await executeTool(name, args, ctxFor(agent));
  return { ...out, json: out.ok ? JSON.parse(out.content) : undefined };
}

describe('tool access per agent (as specified)', () => {
  it('matches the spec exactly', () => {
    const shared = ['evalMath', 'webSearch', 'webFetch'];
    expect(new Set(AGENT_TOOLS.coordinator)).toEqual(
      new Set(['readProfile', 'editProfile', 'readJob', 'editJob', 'readCV', 'readPreferences', 'editPreferences', 'readCSS', 'callWriter', 'callCritic', 'loadSkill', ...shared]),
    );
    expect(new Set(AGENT_TOOLS.writer)).toEqual(new Set(['readCV', 'editCV', 'readPreferences', 'readCSS', 'editCSS', 'readProfile', 'loadSkill', 'callCritic', ...shared]));
    expect(new Set(AGENT_TOOLS.critic)).toEqual(new Set(['readCV', 'readPreferences', 'readJob', 'loadSkill', ...shared]));
  });

  it('refuses tools outside an agent’s set', async () => {
    const out = await call('critic', 'editCV', { jobId: 'x', html: '' });
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/not available to the critic/);
    expect((await call('coordinator', 'editCV', { jobId: 'x', html: '' })).ok).toBe(false);
    expect((await call('writer', 'editPreferences', { jobId: 'x', preferences: { maxPages: 1 } })).ok).toBe(false);
    expect((await call('coordinator', 'nonexistent', {})).ok).toBe(false);
  });

  it('exposes valid JSON schemas to the model', () => {
    for (const tool of Object.values(ALL_TOOLS)) {
      const t = toOllamaTool(tool);
      expect(t.type).toBe('function');
      expect(t.function.parameters?.type).toBe('object');
      expect(t.function.description!.length).toBeGreaterThan(20);
      expect(t.function.parameters).not.toHaveProperty('$schema');
    }
  });
});

describe('argument handling', () => {
  it('reports validation errors back to the model', async () => {
    const out = await call('coordinator', 'evalMath', {});
    expect(out.ok).toBe(false);
    expect(out.content).toMatch(/invalid arguments for evalMath: expression/);
  });
  it('decodes JSON strings for object parameters and stringified argument objects', () => {
    expect(coerceArgs('{"expression":"1+1"}', ALL_TOOLS.evalMath)).toEqual({ expression: '1+1' });
    expect(coerceArgs({ jobId: 'x', preferences: '{"maxPages":1}' }, ALL_TOOLS.editPreferences)).toEqual({ jobId: 'x', preferences: { maxPages: 1 } });
    expect(coerceArgs({ path: 'a', value: null }, ALL_TOOLS.editProfile)).toEqual({ path: 'a' });
    expect(coerceArgs(null, ALL_TOOLS.readJob)).toEqual({});
  });
});

describe('readProfile / editProfile', () => {
  it('writes the whole profile, then reads all, by path and by search', async () => {
    const profile = { name: 'Ada', experience: [{ title: 'Engineer', company: 'Acme', highlights: ['Python on AWS'] }] };
    expect((await call('coordinator', 'editProfile', { profile })).json).toMatchObject({ mode: 'write', ok: true });
    expect((await call('coordinator', 'readProfile', {})).json.profile).toEqual(profile);
    expect((await call('coordinator', 'readProfile', { path: 'experience[0].company' })).json.value).toBe('Acme');
    const search = (await call('coordinator', 'readProfile', { query: 'python' })).json;
    expect(search).toMatchObject({ mode: 'search', matchCount: 1, matches: [{ path: 'experience[0].highlights[0]' }] });
    expect(search.entries['experience[0]']).toEqual(profile.experience[0]);
    expect(events).toContainEqual({ type: 'data_changed', kind: 'profile' });
  });

  it('updates with set, merge, append and remove', async () => {
    await call('coordinator', 'editProfile', { path: 'name', value: 'Ada' });
    await call('coordinator', 'editProfile', { op: 'merge', path: 'contact', value: { email: 'a@b.co' } });
    await call('coordinator', 'editProfile', { op: 'append', path: 'skills', value: 'Python' });
    await call('coordinator', 'editProfile', { op: 'append', path: 'skills', value: 'SQL' });
    await call('coordinator', 'editProfile', { op: 'remove', path: 'skills[0]' });
    await call('coordinator', 'editProfile', { op: 'merge', value: { headline: 'Engineer' } });
    const profile = await ctxFor('coordinator').deps.store.getProfile('u1');
    expect(profile).toMatchObject({ name: 'Ada', headline: 'Engineer', skills: ['SQL'], contact: { email: 'a@b.co', phone: '' } });
  });

  it('explains bad updates', async () => {
    expect((await call('coordinator', 'editProfile', { value: 1 })).content).toMatch(/Provide `profile`/);
    expect((await call('coordinator', 'editProfile', { path: 'name' })).content).toMatch(/needs a value/);
    expect((await call('coordinator', 'editProfile', { path: '', value: [] })).content).toMatch(/must stay an object/);
  });
});

describe('readJob / editJob', () => {
  it('creates, lists, reads, updates and deletes jobs', async () => {
    const created = (await call('coordinator', 'editJob', { job: { title: 'Engineer', company: 'Acme', description: 'Posting' } })).json;
    const id = created.job.id;
    expect(created.mode).toBe('create');
    expect((await call('coordinator', 'readJob', {})).json.jobs).toEqual([expect.objectContaining({ id, title: 'Engineer' })]);
    expect((await call('critic', 'readJob', { jobId: id })).json.job.description).toBe('Posting');
    expect((await call('coordinator', 'editJob', { jobId: id, job: { status: 'applied' } })).json.job.status).toBe('applied');
    expect((await call('coordinator', 'editJob', { jobId: id, delete: true })).json).toEqual({ mode: 'delete', jobId: id, deleted: true });
    expect((await call('coordinator', 'readJob', { jobId: id })).content).toMatch(/not found/);
    expect(events.filter((e) => e.type === 'data_changed' && e.kind === 'job')).toHaveLength(3);
  });

  it('requires fields', async () => {
    expect((await call('coordinator', 'editJob', {})).content).toMatch(/Provide `job`/);
  });
});

describe('readCV / editCV / readPreferences / editPreferences / readCSS / editCSS', () => {
  let jobId: string;
  beforeEach(async () => {
    jobId = (await ctxFor('writer').deps.store.createJob('u1', { title: 'Engineer' })).id;
  });

  it('writes full HTML, applies edits and sanitises', async () => {
    await call('writer', 'editCV', { jobId, html: '<h1>Ada</h1><p>Old</p><script>x()</script>' });
    await call('writer', 'editCV', { jobId, edits: [{ find: 'Old', replace: 'New' }] });
    expect((await call('coordinator', 'readCV', { jobId })).json).toEqual({ jobId, html: '<h1>Ada</h1><p>New</p>' });
    expect(events).toContainEqual({ type: 'data_changed', kind: 'cv', jobId });
  });

  it('reads defaults, then merges preference changes and keeps other fields', async () => {
    expect((await call('critic', 'readPreferences', { jobId })).json.preferences).toEqual(DEFAULT_PREFERENCES);
    const out = (await call('coordinator', 'editPreferences', { jobId, preferences: { maxPages: '1', exclude: ['interests'], font: 'serif' } })).json;
    expect(out.preferences).toEqual({ ...DEFAULT_PREFERENCES, maxPages: 1, exclude: ['interests'], font: 'serif' });
    expect((await call('writer', 'readPreferences', { jobId })).json.preferences).toEqual(out.preferences);
    expect(events).toContainEqual({ type: 'data_changed', kind: 'preferences', jobId });
  });

  it('validates preference changes', async () => {
    expect((await call('coordinator', 'editPreferences', { jobId, preferences: { pageSize: 'A3' } })).content).toMatch(/invalid arguments.*pageSize/);
    expect((await call('coordinator', 'editPreferences', { jobId, preferences: { maxPages: 0 } })).content).toMatch(/invalid arguments.*maxPages/);
    expect((await call('coordinator', 'editPreferences', { jobId, preferences: {} })).content).toMatch(/at least one preference/);
    expect((await call('coordinator', 'editPreferences', { jobId: 'missing', preferences: { maxPages: 1 } })).content).toMatch(/not found/);
  });

  it('reports failed edits without changing the CV', async () => {
    await call('writer', 'editCV', { jobId, html: '<p>Same</p>' });
    const out = await call('writer', 'editCV', { jobId, edits: [{ find: 'Missing', replace: 'x' }] });
    expect(out.ok).toBe(false);
    expect((await call('writer', 'readCV', { jobId })).json.html).toBe('<p>Same</p>');
    expect((await call('writer', 'editCV', { jobId })).content).toMatch(/Provide html or edits/);
  });

  it('reads and edits CSS, rejecting HTML in stylesheets', async () => {
    expect((await call('coordinator', 'readCSS', { jobId })).json.css).toContain('@page');
    await call('writer', 'editCSS', { jobId, css: 'h1 { color: red; }' });
    await call('writer', 'editCSS', { jobId, edits: [{ find: 'red', replace: 'navy' }] });
    expect((await call('writer', 'readCSS', { jobId })).json.css).toBe('h1 { color: navy; }');
    expect((await call('writer', 'editCSS', { jobId, css: '</style><script>' })).content).toMatch(/must not contain HTML/);
    expect(events).toContainEqual({ type: 'data_changed', kind: 'css', jobId });
  });
});

describe('subagent tools', () => {
  it('callWriter briefs the writer with the job and saved preferences', async () => {
    const jobId = (await ctxFor('coordinator').deps.store.createJob('u1', { title: 'Engineer', company: 'Acme', description: 'Needs Go' })).id;
    await call('coordinator', 'editPreferences', { jobId, preferences: { maxPages: 1 } });
    const out = (await call('coordinator', 'callWriter', { jobId, instructions: 'Draft a CV' })).json;
    expect(out.agent).toBe('writer');
    const [agent, brief] = spawn.mock.calls[0];
    expect(agent).toBe('writer');
    expect(brief).toContain('Draft a CV');
    expect(brief).toContain('Needs Go');
    expect(brief).toContain('"maxPages": 1');
  });

  it('callCritic is available to the coordinator and the writer, not the critic', async () => {
    const jobId = (await ctxFor('coordinator').deps.store.createJob('u1', { title: 'Engineer' })).id;
    expect((await call('coordinator', 'callCritic', { jobId, focus: 'keywords' })).json.agent).toBe('critic');
    expect((await call('writer', 'callCritic', { jobId })).json.critique).toMatch(/critic report/);
    expect(spawn.mock.calls[0][1]).toContain('Focus: keywords');
    expect(spawn.mock.calls[0][1]).toContain('## User profile (the only evidence of what is true)');
    expect(spawn.mock.calls[0][1]).toContain('"experience": []');
    expect((await call('critic', 'callCritic', { jobId })).ok).toBe(false);
  });

  it('fails cleanly for unknown jobs', async () => {
    expect((await call('coordinator', 'callWriter', { jobId: 'missing', instructions: 'x' })).content).toMatch(/not found/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('shared tools: evalMath, webSearch, webFetch, loadSkill', () => {
  it.each(['coordinator', 'writer', 'critic'] as const)('%s can use all shared tools', async (agent) => {
    expect((await call(agent, 'evalMath', { expression: '2 * (3 + 4)' })).json.result).toBe(14);
    expect((await call(agent, 'webSearch', { query: 'acme careers', maxResults: '1' })).json.results).toHaveLength(1);
    expect((await call(agent, 'webFetch', { url: 'https://acme.test/job' })).json.title).toBe('Senior Engineer at Acme');
  });

  it('loads only the calling agent’s skills', async () => {
    const skill = (await call('writer', 'loadSkill', { name: 'ats-cv-html' })).json;
    expect(skill.content).toContain('ATS');
    expect(skill.bundledFiles).toContain('references/template.html');
    expect((await call('writer', 'loadSkill', { name: 'ats-cv-html', file: 'references/template.html' })).json.content).toContain('<header');
    expect((await call('critic', 'loadSkill', { name: 'ats-cv-html' })).content).toMatch(/Unknown skill/);
    expect((await call('critic', 'loadSkill', { name: 'cv-review-rubric' })).ok).toBe(true);
    expect((await call('coordinator', 'loadSkill', { name: 'profile-interview' })).ok).toBe(true);
  });

  it('surfaces web errors as tool errors', async () => {
    const web = new FakeWeb();
    web.search = async () => {
      throw new Error('Web search needs OLLAMA_API_KEY to be set');
    };
    const ctx = { ...ctxFor('coordinator'), deps: { ...ctxFor('coordinator').deps, web } };
    const out = await executeTool('webSearch', { query: 'x' }, ctx);
    expect(out).toEqual({ ok: false, content: 'Error: Web search needs OLLAMA_API_KEY to be set' });
  });
});
