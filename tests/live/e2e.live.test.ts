import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_MODELS } from '../../src/config.js';
import { chromePdfRenderer, findChrome } from '../../src/cv/pdf.js';
import { OllamaChatModel, OLLAMA_CLOUD_HOST, OLLAMA_LOCAL_HOST } from '../../src/llm/ollama.js';
import { Store } from '../../src/storage/store.js';
import { LISTING, tempDir } from '../support/fixtures.js';
import { converse, startServer } from '../support/http.js';

/**
 * The real product on real Ollama cloud models: a simulated user answers the coach until an
 * approved PDF exists. Uses your Ollama quota; run with `npm run test:live`.
 */
const live = process.env.CV_WRITER_LIVE === '1';

const ANSWERS = [
  "I'm Ada Lovelace, ada@example.com, +44 7700 900123, London UK. I want platform engineering roles.",
  'Software Engineer at Analytical Engines Ltd, London, since Sep 2021. I built a Python payments API serving 40,000 requests per minute on AWS, and cut deployment time from 45 to 8 minutes with GitHub Actions. I also manage 30 AWS accounts with Terraform. Skills: Python, TypeScript, SQL, PostgreSQL, AWS, Terraform, GitHub Actions.',
  'BSc Mathematics, University of London, 2018 to 2021, first-class honours. No certifications.',
  `Here is the listing:\n\n${LISTING}`,
  'No Kubernetes or Go experience. That is everything — please write the CV now.',
  'It looks good. Fix anything the critic flagged as critical, otherwise approve the best version and export the PDF.',
  'Yes, approve it now.',
  'Please approve the latest version that has no errors.',
];

describe.skipIf(!live)('live: real models from hello to approved PDF', () => {
  let cleanup: () => Promise<void>;
  let store: Store;
  let server: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    const t = await tempDir('cv-writer-live-');
    cleanup = t.cleanup;
    store = new Store(t.dir);
    const apiKey = process.env.OLLAMA_API_KEY;
    const chrome = await findChrome();
    server = await startServer({
      store,
      llm: new OllamaChatModel({ host: apiKey ? OLLAMA_CLOUD_HOST : OLLAMA_LOCAL_HOST, ...(apiKey ? { apiKey } : {}) }),
      models: {
        coordinator: process.env.CV_WRITER_MODEL ?? DEFAULT_MODELS.coordinator,
        writer: process.env.CV_WRITER_WRITER_MODEL ?? DEFAULT_MODELS.writer,
        critic: process.env.CV_WRITER_CRITIC_MODEL ?? DEFAULT_MODELS.critic,
      },
      ...(chrome ? { pdf: chromePdfRenderer(chrome) } : {}),
    });
    console.log(`live data: ${t.dir}`);
  });
  afterAll(async () => {
    await server?.close();
    if (process.env.CV_WRITER_KEEP !== '1') await cleanup?.();
  });

  it('interviews, writes, reviews and approves', async () => {
    const session = await store.createSession();
    const opened = await converse(`${server.url}/api/sessions/${session.id}/open`);
    expect(opened.error).toBeUndefined();
    console.log(`coach: ${opened.reply}`);

    for (const answer of ANSWERS) {
      const approved = (await listApproved(store)).length > 0;
      if (approved) break;
      console.log(`user: ${answer.slice(0, 100)}`);
      const r = await converse(`${server.url}/api/sessions/${session.id}/messages`, { text: answer });
      expect(r.error).toBeUndefined();
      console.log(`coach: ${r.reply}`);
    }

    const profile = await store.getProfile();
    expect(profile.contact.name).toMatch(/Ada Lovelace/);
    expect(profile.entries.some((e) => e.section === 'experience')).toBe(true);
    const [job] = await store.listJobs();
    expect(job?.description).toContain('Babbage Systems');
    const versions = await store.listCvVersions(job!.id);
    expect(versions.length).toBeGreaterThan(0);
    expect(versions.some((v) => v.critiques.length > 0)).toBe(true);
    const approved = await listApproved(store);
    expect(approved.length).toBeGreaterThan(0);
    expect(approved[0]!.checks.errorCount).toBe(0);
    expect(approved[0]!.exports.length).toBeGreaterThan(0);
  });
});

async function listApproved(store: Store) {
  const jobs = await store.listJobs();
  const all = (await Promise.all(jobs.map((j) => store.listCvVersions(j.id)))).flat();
  return all.filter((v) => v.status === 'approved');
}
