import type { CritiqueInput } from '../../src/cv/critique.ts';

export const PROFILE = `# Alex Morgan

## Contact
- Email: alex.morgan@example.com
- Phone: +44 7700 900456
- Location: Bristol, UK
- LinkedIn: linkedin.com/in/alexmorgan

## Experience

### Product Manager — Lumen Health (Jan 2021 – present)
- Led discovery and launch of a patient booking app used by 40,000 patients.
- Cut appointment no-shows by 18% with SMS reminders.
- Managed a team of 6 engineers and 1 designer.

### Business Analyst — Acme Insurance (Sep 2017 – Dec 2020)
- Mapped claims processes and automated 3 manual reports, saving 10 hours per week.

## Education
- BSc Economics, University of Bristol, 2014 – 2017

## Skills
- Roadmapping, user research, SQL, Jira, A/B testing

## Preferences
- UK spelling
- Maximum 2 pages
`;

export const LISTING = `# Senior Product Manager — Brightwave

Brightwave is hiring a Senior Product Manager to own our patient-facing mobile apps.

## Requirements
- 4+ years of product management experience
- Experience with healthcare or regulated products
- Strong data skills (SQL, experimentation)
- Leading cross-functional teams
`;

export const CV_HTML = `<header>
  <h1>Alex Morgan</h1>
  <p class="headline">Product Manager</p>
  <ul class="contact">
    <li>alex.morgan@example.com</li>
    <li>+44 7700 900456</li>
    <li>Bristol, UK</li>
  </ul>
</header>
<section class="summary">
  <h2>Profile</h2>
  <p>Product manager with healthcare experience, launching patient-facing products that improve access and reduce no-shows.</p>
</section>
<section class="experience">
  <h2>Experience</h2>
  <article class="entry">
    <div class="entry-head">
      <h3><span class="role">Product Manager</span><span class="org">Lumen Health</span></h3>
      <span class="dates">Jan 2021 – Present</span>
    </div>
    <ul>
      <li>Led discovery and launch of a patient booking app used by 40,000 patients.</li>
      <li>Cut appointment no-shows by 18% by introducing SMS reminders.</li>
      <li>Managed a cross-functional team of 6 engineers and 1 designer.</li>
    </ul>
  </article>
  <article class="entry">
    <div class="entry-head">
      <h3><span class="role">Business Analyst</span><span class="org">Acme Insurance</span></h3>
      <span class="dates">Sep 2017 – Dec 2020</span>
    </div>
    <ul>
      <li>Automated 3 manual claims reports, saving 10 hours per week.</li>
    </ul>
  </article>
</section>
<section class="skills">
  <h2>Skills</h2>
  <ul class="skill-groups"><li><strong>Product:</strong> Roadmapping, user research, A/B testing</li><li><strong>Data:</strong> SQL, Jira</li></ul>
</section>
<section class="education">
  <h2>Education</h2>
  <article class="entry">
    <div class="entry-head">
      <h3><span class="role">BSc Economics</span><span class="org">University of Bristol</span></h3>
      <span class="dates">2014 – 2017</span>
    </div>
  </article>
</section>`;

export function critiqueInput(overrides: Partial<CritiqueInput> = {}): CritiqueInput {
  return {
    summary: 'A focused, truthful CV with clear healthcare product impact.',
    scores: { relevance: 9, impact: 8, clarity: 8, structure: 9, accuracy: 10 },
    coverage: [
      { requirement: '4+ years of product management', status: 'met', evidence: 'Product Manager since 2021 plus BA work' },
      { requirement: 'Healthcare experience', status: 'met', evidence: 'Lumen Health' },
    ],
    mistakes: [],
    factualIssues: [],
    strengths: ['Quantified outcomes'],
    improvements: ['Add an experimentation example'],
    questionsForCandidate: ['Have you run A/B tests at Lumen Health?'],
    ...overrides,
  };
}

/** A CV long enough to need several pages. */
export function longCv(entries = 14): string {
  const bullets = Array.from({ length: 6 }, () => '<li>Led discovery and launch of a patient booking app used by 40,000 patients across many regions.</li>').join('');
  const items = Array.from(
    { length: entries },
    (_v, i) =>
      `<article class="entry"><div class="entry-head"><h3><span class="role">Role ${i}</span><span class="org">Org ${i}</span></h3><span class="dates">2020</span></div><ul>${bullets}</ul></article>`,
  ).join('');
  return `<header><h1>Alex Morgan</h1><ul class="contact"><li>alex.morgan@example.com</li></ul></header><section class="experience"><h2>Experience</h2>${items}</section>`;
}
