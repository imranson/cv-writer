import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach } from 'vitest';
import type { CvDocument, JobListingInput, Profile } from '../src/domain/schemas.js';
import { CvStore } from '../src/storage/store.js';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cv-writer-test-'));
  dirs.push(dir);
  return dir;
}

/** A store with a deterministic clock (+1s per call) and sequential ids. */
export async function tempStore(): Promise<CvStore> {
  let tick = 0;
  let id = 0;
  return new CvStore(await tempDir(), {
    now: () => new Date(Date.UTC(2026, 9, 4, 12, 0, tick++)),
    randomId: () => `id${++id}`,
  });
}

export function sampleProfile(): Profile {
  return {
    revision: 3,
    updatedAt: '2026-10-04T12:00:00.000Z',
    contact: {
      name: 'Alex Morgan',
      email: 'alex.morgan@example.com',
      phone: '+44 7700 900123',
      location: 'Manchester, UK',
      links: ['github.com/alexmorgan'],
    },
    headline: 'Graduate software engineer focused on backend and ML systems',
    entries: [
      {
        id: 'education-1',
        section: 'education',
        title: 'BSc Computer Science (First Class)',
        organisation: 'The University of Manchester',
        startDate: 'Sept 2023',
        endDate: 'June 2026',
        highlights: ['Final year project on fMRI-to-text decoding, awarded 71%'],
        skills: ['Python', 'PyTorch'],
      },
      {
        id: 'experience-1',
        section: 'experience',
        title: 'Research Intern',
        organisation: 'The University of Manchester',
        startDate: 'June 2025',
        endDate: 'Aug 2025',
        summary: 'Privacy-preserving clinical note generation',
        highlights: [
          'Generated synthetic clinical notes from 122,000+ medical records using differential privacy',
          'Built filters that improved generation fidelity by up to 50%',
        ],
        skills: ['PyTorch', 'Hugging Face', 'HPC'],
      },
      {
        id: 'project-1',
        section: 'project',
        title: 'Peer Tutoring Platform',
        organisation: 'Accelerate ME Hackathon',
        startDate: 'Nov 2025',
        highlights: ['Led a team of 3 to build the platform in 7 hours; won the Lovable Challenge'],
        skills: ['React', 'Supabase'],
      },
    ],
    skills: [
      { category: 'Languages', items: ['Python', 'TypeScript', 'SQL'] },
      { category: 'Cloud', items: ['AWS Lambda', 'S3'] },
    ],
    facts: ['UK English spelling', 'Full right to work in the UK'],
  };
}

export function sampleJob(): JobListingInput {
  return {
    title: 'Graduate Software Engineer',
    company: 'Acme Health',
    location: 'Manchester',
    description: 'We are hiring a graduate software engineer to build ML-backed services in Python on AWS.',
    requirements: ['Degree in Computer Science', 'Python', 'Cloud experience'],
    keywords: ['Python', 'AWS', 'machine learning', 'Kubernetes'],
  };
}

export function sampleCv(): CvDocument {
  return {
    name: 'Alex Morgan',
    contactLine: ['Manchester, UK', 'alex.morgan@example.com', '+44 7700 900123', '[github.com/alexmorgan](https://github.com/alexmorgan)'],
    sections: [
      {
        title: 'Profile',
        paragraph: 'Computer Science graduate building machine learning systems in Python on AWS.',
        items: [],
        entries: [],
      },
      {
        title: 'Experience',
        items: [],
        entries: [
          {
            heading: 'Research Intern',
            subheading: 'The University of Manchester',
            dates: 'June 2025 – Aug 2025',
            bullets: [
              'Generated synthetic clinical notes from 122,000+ medical records with differential privacy.',
              'Improved generation fidelity by up to 50% with custom quality filters.',
            ],
            sourceIds: ['experience-1'],
          },
        ],
      },
      {
        title: 'Education',
        items: [],
        entries: [
          {
            heading: 'BSc Computer Science (First Class)',
            subheading: 'The University of Manchester',
            dates: 'Sept 2023 – June 2026',
            bullets: [],
            sourceIds: ['education-1'],
          },
        ],
      },
      {
        title: 'Skills',
        items: ['**Languages:** Python, TypeScript, SQL', '**Cloud:** AWS Lambda, S3'],
        entries: [],
      },
    ],
  };
}

/** Stores sampleProfile() (entry ids included) as the current profile. */
export async function seedProfile(store: CvStore): Promise<Profile> {
  const { revision: _r, updatedAt: _u, ...rest } = sampleProfile();
  return store.updateProfile('seed', {}, (p) => ({ ...p, ...rest }));
}
