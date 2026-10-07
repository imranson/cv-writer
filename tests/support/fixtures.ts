import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CritiqueInput, CvDocument, JobInput, Profile } from '../../src/domain/schemas.js';
import { Store } from '../../src/storage/store.js';

export async function tempDir(prefix = 'cv-writer-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export const PROFILE: Profile = {
  revision: 3,
  updatedAt: '2026-10-01T10:00:00.000Z',
  contact: { name: 'Ada Lovelace', email: 'ada@example.com', phone: '+44 7700 900123', location: 'London, UK', links: ['github.com/ada'] },
  headline: 'Backend engineer moving into platform engineering',
  entries: [
    {
      id: 'experience-aaa111',
      section: 'experience',
      title: 'Software Engineer',
      organisation: 'Analytical Engines Ltd',
      location: 'London',
      startDate: 'Sep 2021',
      endDate: 'Present',
      highlights: ['Built a Python payments API serving 40,000 requests per minute', 'Cut deployment time from 45 to 8 minutes with GitHub Actions'],
      skills: ['Python', 'PostgreSQL', 'AWS', 'GitHub Actions'],
    },
    {
      id: 'education-bbb222',
      section: 'education',
      title: 'BSc Mathematics',
      organisation: 'University of London',
      startDate: '2018',
      endDate: '2021',
      highlights: ['First-class honours'],
      skills: [],
    },
  ],
  skills: [{ category: 'Languages', items: ['Python', 'TypeScript', 'SQL'] }],
  facts: ['Right to work in the UK'],
};

export const LISTING = `Platform Engineer — Babbage Systems, London (hybrid)

We are looking for a Platform Engineer to join our infrastructure team. You will build and run the internal developer platform used by 200 engineers.

Requirements:
- 3+ years of software engineering experience
- Strong Python or Go
- Experience with AWS and infrastructure as code (Terraform)
- CI/CD pipelines (GitHub Actions or similar)
- Kubernetes experience is a plus

We offer a competitive salary, 30 days holiday and a learning budget.`;

export const JOB: JobInput = {
  title: 'Platform Engineer',
  company: 'Babbage Systems',
  location: 'London',
  description: LISTING,
  requirements: ['Python or Go', 'AWS', 'Terraform', 'CI/CD', 'Kubernetes'],
  keywords: ['Python', 'AWS', 'Terraform', 'GitHub Actions', 'Kubernetes'],
};

export const CV_DOC: CvDocument = {
  name: 'Ada Lovelace',
  headline: 'Software Engineer',
  contact: { email: 'ada@example.com', phone: '+44 7700 900123', location: 'London, UK', links: ['github.com/ada'] },
  summary: 'Backend engineer with production Python and AWS experience, moving into platform engineering.',
  sections: [
    {
      kind: 'entries',
      title: 'Experience',
      items: [
        {
          heading: 'Software Engineer',
          subheading: 'Analytical Engines Ltd',
          location: 'London',
          dates: 'Sep 2021 – Present',
          sources: ['experience-aaa111'],
          bullets: [
            { text: 'Built a Python payments API serving 40,000 requests per minute on AWS', sources: [] },
            { text: 'Cut deployment time from 45 to 8 minutes by rebuilding CI/CD in GitHub Actions', sources: [] },
          ],
        },
      ],
    },
    {
      kind: 'entries',
      title: 'Education',
      items: [{ heading: 'BSc Mathematics', subheading: 'University of London', dates: '2018 – 2021', sources: ['education-bbb222'], bullets: [{ text: 'First-class honours', sources: [] }] }],
    },
    { kind: 'skills', title: 'Skills', groups: [{ label: 'Languages', items: ['Python', 'TypeScript', 'SQL'] }, { label: 'Cloud & tools', items: ['AWS', 'PostgreSQL', 'GitHub Actions'] }] },
  ],
};

export const CRITIQUE: CritiqueInput = {
  overallScore: 78,
  verdict: 'needs_work',
  scores: { relevance: 8, impact: 7, clarity: 8, accuracy: 10, presentation: 8 },
  requirementCoverage: [
    { requirement: 'AWS', status: 'met', evidence: 'payments API on AWS' },
    { requirement: 'Terraform', status: 'missing' },
  ],
  issues: [{ severity: 'major', category: 'coverage', problem: 'No infrastructure-as-code evidence', suggestion: 'Ask about Terraform' }],
  strengths: ['Quantified impact'],
  questionsForUser: ['Have you used Terraform?'],
  summary: 'Solid but missing IaC evidence.',
};

/** A store pre-loaded with the fixture profile (written through the history like real edits). */
export async function seededStore(dir: string, options: { job?: boolean } = {}): Promise<{ store: Store; jobId?: string }> {
  const store = new Store(dir);
  await store.updateProfile({ operation: 'seed', actor: 'test', payload: {}, apply: () => ({ ...PROFILE }) });
  if (!options.job) return { store };
  const job = await store.saveJob(JOB);
  return { store, jobId: job.id };
}
