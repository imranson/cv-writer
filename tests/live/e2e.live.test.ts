import { access } from 'node:fs/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'vitest';
import { buildAgentOptions } from '../../src/agents/options.js';
import { createCvTools } from '../../src/agents/tools.js';
import { runConversation, type ChatIO } from '../../src/app/session.js';
import { DEFAULT_MODEL } from '../../src/config.js';
import { chromePdfRenderer, findChrome } from '../../src/cv/export.js';
import { sampleProfile, tempStore } from '../helpers.js';

const LISTING = `Graduate Software Engineer — Acme Health (Manchester, hybrid)

Acme Health builds data products that help NHS trusts plan clinical capacity. We're hiring graduate software engineers to join our ML platform team.

What you'll do:
- Build and maintain Python services that serve machine learning models
- Deploy workloads on AWS (Lambda, S3) and help us move to Kubernetes
- Work with clinicians and data scientists on privacy-sensitive health data

What we're looking for:
- A degree in Computer Science or a related subject (2026 graduates welcome)
- Strong Python; some TypeScript or SQL is a plus
- Interest in machine learning and privacy-preserving data handling
- Clear communication and teamwork`;

/**
 * Real model, real Agent SDK, real tools. The simulated user answers based on what has been
 * saved so far, so the script holds whatever order the coordinator chooses to work in.
 * Run with: npm run test:live   (spends real API credit; capped by maxBudgetUsd)
 */
describe.skipIf(process.env.CV_WRITER_LIVE !== '1')('live: coordinator + cv-writer', () => {
  it('turns a conversation into an approved, exported CV', async () => {
    const store = await tempStore();
    const { revision, updatedAt, ...seed } = sampleProfile();
    await store.updateProfile('seed', {}, (p) => ({ ...p, ...seed }));

    const chrome = await findChrome();
    const tools = createCvTools(store, chrome ? { pdf: chromePdfRenderer(chrome) } : {});
    const model = process.env.CV_WRITER_MODEL ?? DEFAULT_MODEL;
    const options = buildAgentOptions({
      config: { dataDir: store.root, model, writerModel: model, maxBudgetUsd: Number(process.env.CV_WRITER_BUDGET_USD ?? 5) },
      store,
      tools,
    });

    let feedbackGivenAt: number | undefined;
    let replies = 0;
    const log = (line: string) => console.log(line);
    const io: ChatIO = {
      say: (text) => log(`\n[coordinator]\n${text}\n`),
      status: (text) => log(`  · ${text}`),
      async readUserInput() {
        if (++replies > 14) return null;
        const job = (await store.listJobs())[0];
        const versions = job ? await store.listCvVersions(job.id) : [];
        let reply: string | null;
        if (!job) reply = `I'm applying for this job:\n\n${LISTING}`;
        else if (versions.some((v) => v.status === 'approved')) reply = null;
        else if (!versions.length) reply = "My profile is up to date and I've nothing to add — please go ahead and draft the CV.";
        else if (feedbackGivenAt === undefined) {
          feedbackGivenAt = versions.length;
          reply = 'Thanks! One change please: make the opening profile paragraph a single sentence.';
        } else if (versions.length > feedbackGivenAt) reply = 'Perfect — I approve the latest version. Please finalise it.';
        else reply = 'Please go ahead with that revision.';
        log(`\n[user] ${reply ?? '(leaves)'}`);
        return reply;
      },
    };

    const summary = await runConversation({ io, query, options });
    log(`\nsession ${summary.sessionId}: ${summary.turns} turns, $${summary.costUsd.toFixed(2)}, ended by ${summary.endedBy}`);

    expect(summary.endedBy).toBe('user');
    const jobs = await store.listJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.description).toContain('ML platform team');
    expect(jobs[0]!.keywords.length).toBeGreaterThan(0);

    const versions = await store.listCvVersions(jobs[0]!.id);
    expect(versions.length).toBeGreaterThanOrEqual(2);
    expect(versions.slice(feedbackGivenAt).some((v) => v.basedOnVersion !== undefined)).toBe(true);

    const approved = versions.find((v) => v.status === 'approved');
    expect(approved?.verification.passed).toBe(true);
    for (const file of Object.values(approved!.exports!)) await access(file);
    const profileParagraph = approved!.document.sections[0]?.paragraph ?? '';
    log(`\nApproved CV (v${approved!.version}):\n\n${approved!.markdown}`);
    expect(profileParagraph.split(/[.!?](\s|$)/).filter((s) => s.trim().length > 1).length).toBeLessThanOrEqual(1);

    const audit = await store.readAudit();
    const saves = audit.filter((e) => e.action.endsWith('save_cv_version'));
    expect(saves.filter((e) => e.ok).every((e) => e.actor === 'cv-writer')).toBe(true);
    expect(audit.some((e) => e.action === 'approve_cv' && e.ok && e.actor === 'coordinator')).toBe(true);
  });
});
