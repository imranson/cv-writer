import { access } from 'node:fs/promises';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { buildAgentOptions } from '../../src/agents/options.js';
import { createCvTools } from '../../src/agents/tools.js';
import { runConversation } from '../../src/app/session.js';
import { sampleCv, sampleJob, tempStore } from '../helpers.js';
import { fakeQuery, ScriptedIO, sdk } from '../support/fakeSdk.js';
import { simulatedRuntime } from '../support/simulatedRuntime.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => cleanup?.());

/**
 * The real session loop, agent options, policy hook, MCP server and store, driven by a
 * scripted stand-in for the model. Proves the pieces are wired together; the live test
 * covers real model behaviour.
 */
describe('coordinator conversation (scripted model)', () => {
  it('goes from greeting to an approved, exported CV in one session', async () => {
    const store = await tempStore();
    const tools = createCvTools(store, { pdf: async () => {} });
    const options = buildAgentOptions({
      config: { dataDir: store.root, model: 'claude-opus-5-5', writerModel: 'claude-opus-5-5' },
      store,
      tools,
    });
    const runtime = await simulatedRuntime(options);
    cleanup = runtime.close;

    const events: string[] = [];
    let jobId = '';
    const writer = { agentId: 'agent-1', agentType: 'cv-writer' };

    /** Emits a tool_use message and runs the call, like the SDK does. */
    async function use(out: SDKMessage[], name: string, input: Record<string, unknown>, caller = {}) {
      out.push(sdk.toolUse(name, input, 'agentId' in caller ? 'tu-agent' : null));
      const result = await runtime.callTool(name, input, caller);
      events.push(`${'agentType' in caller ? 'writer' : 'coordinator'} ${name.replace('mcp__cv__', '')}: ${result.denied ? 'denied' : result.isError ? 'error' : 'ok'}`);
      return result;
    }

    const { query } = fakeQuery(async (_text, turn) => {
      const out: SDKMessage[] = [];
      if (turn === 0) {
        await use(out, 'mcp__cv__get_profile', {});
        out.push(sdk.text("Welcome! Your profile is empty — what's your name and how can I reach you?"));
      } else if (turn === 1) {
        await use(out, 'mcp__cv__update_contact', { name: 'Alex Morgan', email: 'alex.morgan@example.com' });
        await use(out, 'mcp__cv__upsert_profile_entry', { id: 'experience-1', section: 'experience', title: 'Research Intern', organisation: 'The University of Manchester', startDate: 'June 2025', endDate: 'Aug 2025', highlights: ['Generated synthetic clinical notes from 122,000+ medical records', 'Improved fidelity by up to 50%'] });
        await use(out, 'mcp__cv__upsert_profile_entry', { id: 'education-1', section: 'education', title: 'BSc Computer Science (First Class)', organisation: 'The University of Manchester', startDate: 'Sept 2023', endDate: 'June 2026' });
        await use(out, 'mcp__cv__add_skills', { category: 'Languages', items: ['Python', 'TypeScript', 'SQL'] });
        await use(out, 'mcp__cv__add_skills', { category: 'Cloud', items: ['AWS Lambda', 'S3'] });
        out.push(sdk.text('Saved. Please paste the job listing.'));
      } else if (turn === 2) {
        jobId = (await use(out, 'mcp__cv__save_job_listing', sampleJob())).json!().jobId;
        // The coordinator may not write CVs itself...
        await use(out, 'mcp__cv__save_cv_version', { jobId, document: sampleCv(), changeSummary: 'x' });
        // ...nor start any agent other than the writer.
        await use(out, 'Agent', { subagent_type: 'general-purpose', prompt: 'write it', description: 'x' });
        await use(out, 'Agent', { subagent_type: 'cv-writer', prompt: `Draft a CV for job ${jobId}`, description: 'Draft CV' });
        // The writer reads, cannot touch the profile, and saves its draft.
        await use(out, 'mcp__cv__get_job_listing', { jobId }, writer);
        await use(out, 'mcp__cv__get_profile', {}, writer);
        await use(out, 'mcp__cv__update_contact', { phone: '000' }, writer);
        await use(out, 'mcp__cv__approve_cv', { jobId, version: 1 }, writer);
        await use(out, 'mcp__cv__save_cv_version', { jobId, document: sampleCv(), changeSummary: 'Tailored to ML + AWS' }, writer);
        out.push(sdk.text('Version 1 saved; leads with ML research.', 'tu-agent'));
        const shown = await use(out, 'mcp__cv__get_cv_version', { jobId });
        out.push(sdk.text(`Here is your draft:\n\n${shown.text!.split('----- CV (Markdown) -----')[1]!.trim()}`));
      } else if (turn === 3) {
        const approved = await use(out, 'mcp__cv__approve_cv', { jobId, version: 1 });
        out.push(sdk.text(`Approved. Files: ${approved.json!().files.html}`));
      }
      out.push(sdk.result({ total_cost_usd: 0.05 * (turn + 1) }));
      return out;
    });

    const io = new ScriptedIO([
      'Alex Morgan, alex.morgan@example.com. Research intern at Manchester, BSc CS...',
      'Graduate Software Engineer at Acme Health: ...',
      'Looks great — approve it.',
      '/quit',
    ]);
    const summary = await runConversation({ io, query, options });

    expect(summary).toMatchObject({ sessionId: 'sess-1', turns: 4, endedBy: 'user' });
    expect(events).toEqual([
      'coordinator get_profile: ok',
      'coordinator update_contact: ok',
      'coordinator upsert_profile_entry: ok',
      'coordinator upsert_profile_entry: ok',
      'coordinator add_skills: ok',
      'coordinator add_skills: ok',
      'coordinator save_job_listing: ok',
      'coordinator save_cv_version: denied',
      'coordinator Agent: denied',
      'coordinator Agent: ok',
      'writer get_job_listing: ok',
      'writer get_profile: ok',
      'writer update_contact: denied',
      'writer approve_cv: denied',
      'writer save_cv_version: ok',
      'coordinator get_cv_version: ok',
      'coordinator approve_cv: ok',
    ]);

    // What the user saw.
    expect(io.said.find((t) => t.startsWith('Here is your draft'))).toContain('# Alex Morgan\n\nManchester, UK');
    expect(io.said.join('\n')).not.toContain('leads with ML research'); // writer chatter stays internal
    expect(io.statuses).toContain('cv-writer: Saving a CV draft and running checks');

    // What was stored.
    const cv = (await store.getCvVersion(jobId, 1))!;
    expect(cv).toMatchObject({ status: 'approved', profileRevision: 5, verification: { passed: true } });
    await access(cv.exports!.html);
    await access(cv.exports!.markdown);
    const denials = (await store.readAudit()).filter((e) => !e.ok).map((e) => `${e.actor} ${e.action}`);
    expect(denials).toEqual(['coordinator mcp__cv__save_cv_version', 'coordinator Agent']);
  });
});
