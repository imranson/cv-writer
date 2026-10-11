import type { ChatRequest } from '../../src/llm/types.js';
import { call, calls, lastToolResult, say, ScriptedLLM, step, type Script } from './scriptedLlm.js';

export const ADA_PROFILE = {
  name: 'Ada Lovelace',
  headline: 'Analytical engine programmer',
  contact: { email: 'ada@example.com', location: 'London' },
  experience: [
    {
      title: 'Lead Programmer',
      company: 'Analytical Engines Ltd',
      start: '2021-01',
      end: 'present',
      highlights: ['Wrote the first published algorithm, cutting computation time by 40%'],
    },
  ],
  skills: ['Algorithms', 'TypeScript', 'Mathematics'],
};

export const ACME_JOB = {
  title: 'Senior TypeScript Engineer',
  company: 'Acme',
  description: 'Build Node.js services in TypeScript. Strong algorithms background required.',
  keywords: ['TypeScript', 'Node.js', 'algorithms'],
};

export const ADA_CV_HTML = `<header class="cv-header"><h1>Ada Lovelace</h1><p class="headline">Senior TypeScript Engineer</p>
<ul class="contact"><li>ada@example.com</li><li>London</li></ul></header>
<section class="cv-section experience"><h2>Experience</h2>
<article class="entry"><div class="entry-head"><h3>Lead Programmer, Analytical Engines Ltd</h3><span class="dates">Jan 2021 – Present</span></div>
<ul><li>Wrote the first published algorithm, cutting computation time by 40%</li></ul></article></section>`;

function between(text: string, label: string): string {
  const match = new RegExp(`${label}: ([a-z0-9-]+)`).exec(text);
  if (!match) throw new Error(`No ${label} in brief`);
  return match[1];
}

const brief = (req: ChatRequest) => req.messages.find((m) => m.role === 'user')!.content;

/**
 * A complete happy path: coordinator saves profile and job, delegates to the writer,
 * which writes the CV and asks the critic, then everyone reports back.
 */
export const journeyScripts: Record<'coordinator' | 'writer' | 'critic', Script> = {
  coordinator: (req) => {
    switch (step(req)) {
      case 0:
        return call('writeProfile', { profile: ADA_PROFILE }, 'Thanks Ada, saving your profile.');
      case 1: {
        const profile = lastToolResult(req, 'writeProfile');
        return call('writeJob', { profileId: profile.id, job: ACME_JOB });
      }
      case 2: {
        const job = lastToolResult(req, 'writeJob');
        return call('callWriter', {
          jobId: job.id,
          profileId: job.profileId,
          instructions: 'Write a one-page CV in a formal tone emphasising algorithms.',
        });
      }
      default:
        return say('Your CV for **Acme** is ready in the preview panel. Shall we tweak anything?');
    }
  },
  writer: (req) => {
    const jobId = between(brief(req), 'Job id');
    switch (step(req)) {
      case 0:
        return call('readProfile', { profileId: between(brief(req), 'Profile id') });
      case 1:
        return call('writeCV', { jobId, html: ADA_CV_HTML, preferences: { tone: 'formal', pages: 1, emphasis: ['algorithms'] } });
      case 2:
        return call('callCritic', { jobId, focus: 'relevance' });
      default:
        return say('WRITER REPORT: CV written; critic scored 8/10; addressed keyword coverage.');
    }
  },
  critic: (req) => {
    const jobId = between(brief(req), 'Job id');
    if (step(req) === 0) return calls(['readCV', { jobId }], ['readJob', { jobId }]);
    return say('CRITIC: 8/10. 1. Add Node.js evidence. 2. Quantify more bullets.');
  },
};

export function journeyLlm(): ScriptedLLM {
  return new ScriptedLLM(journeyScripts, 262_144);
}
