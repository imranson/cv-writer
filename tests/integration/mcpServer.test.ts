import { afterEach, describe, expect, it } from 'vitest';
import { createCvMcpServer, createCvTools } from '../../src/agents/tools.js';
import { sampleCv, sampleJob, tempStore } from '../helpers.js';
import { connectMcp } from '../support/mcp.js';

let closeClient: (() => Promise<void>) | undefined;
afterEach(async () => closeClient?.());

async function connect() {
  const store = await tempStore();
  const mcp = await connectMcp(createCvMcpServer(createCvTools(store)));
  closeClient = mcp.close;
  return { store, ...mcp };
}

describe('cv MCP server (over the MCP protocol)', () => {
  it('advertises every tool with a JSON schema (none dropped during schema conversion)', async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'add_facts', 'add_highlights', 'add_skills', 'approve_cv', 'get_cv_version', 'get_job_listing', 'get_profile',
      'list_cv_versions', 'list_job_listings', 'remove_profile_entry', 'save_cv_version', 'save_job_listing',
      'set_headline', 'update_contact', 'upsert_profile_entry',
    ]);
    const save = tools.find((t) => t.name === 'save_cv_version')!;
    expect(save.inputSchema.required).toEqual(expect.arrayContaining(['jobId', 'document', 'changeSummary']));
    const doc = (save.inputSchema.properties as Record<string, any>).document;
    expect(doc.properties.sections.items.properties.entries.items.properties.sourceIds.type).toBe('array');
    const upsert = tools.find((t) => t.name === 'upsert_profile_entry')!;
    expect((upsert.inputSchema.properties as Record<string, any>).section.enum).toContain('experience');
    expect(tools.find((t) => t.name === 'get_profile')!.annotations?.readOnlyHint).toBe(true);
    expect(save.annotations?.readOnlyHint).toBe(false);
  });

  it('validates arguments at the protocol boundary', async () => {
    const { call, store } = await connect();
    const bad = await call('upsert_profile_entry', { section: 'hobbies', title: 'Chess' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/section/i);
    expect((await call('add_facts', { facts: [] })).isError).toBe(true);
    expect((await store.getProfile()).revision).toBe(0);
  });

  it('runs a profile → job → CV → approval flow through protocol calls', async () => {
    const { call, store } = await connect();
    await call('update_contact', { name: 'Alex Morgan', email: 'alex.morgan@example.com', phone: '+44 7700 900123', location: 'Manchester, UK' });
    const exp = (await call('upsert_profile_entry', {
      section: 'experience', title: 'Research Intern', organisation: 'The University of Manchester', startDate: 'June 2025', endDate: 'Aug 2025',
      highlights: ['Generated synthetic clinical notes from 122,000+ medical records using differential privacy', 'Built filters that improved generation fidelity by up to 50%'],
    })).json().entry;
    const edu = (await call('upsert_profile_entry', { section: 'education', title: 'BSc Computer Science (First Class)', organisation: 'The University of Manchester' })).json().entry;
    await call('add_skills', { category: 'Languages', items: ['Python', 'TypeScript', 'SQL'] });
    await call('add_skills', { category: 'Cloud', items: ['AWS Lambda', 'S3'] });

    const { jobId } = (await call('save_job_listing', sampleJob())).json();
    const doc = sampleCv();
    doc.sections[1]!.entries[0]!.sourceIds = [exp.id];
    doc.sections[2]!.entries[0]!.sourceIds = [edu.id];
    delete doc.sections[2]!.entries[0]!.dates;

    // Defaults (items/entries/bullets) are filled in by schema validation on the server.
    const sections = doc.sections.map(({ items, ...s }) => (items.length ? { ...s, items } : s));
    const saved = (await call('save_cv_version', { jobId, document: { ...doc, sections }, changeSummary: 'first' })).json();
    expect(saved.issues).toEqual([]);
    expect(saved.verificationPassed).toBe(true);

    const shown = await call('get_cv_version', { jobId });
    expect(shown.text).toContain('**Research Intern**, The University of Manchester');

    const approved = (await call('approve_cv', { jobId, version: 1 })).json();
    expect(approved.files.html).toMatch(/alex-morgan-cv-v1\.html$/);
    expect((await store.getCvVersion(jobId, 1))?.status).toBe('approved');
  });
});
