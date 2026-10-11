import { api } from '../api.ts';
import { h, mount, timeAgo, toast } from '../dom.ts';
import { bus, jobById } from '../state.ts';
import type { CheckFinding, Critique } from '../types.ts';

const DIMENSIONS: [keyof Critique['scores'], string][] = [
  ['relevance', 'Relevance to job'],
  ['impact', 'Impact & evidence'],
  ['clarity', 'Clarity'],
  ['structure', 'Structure & format'],
  ['accuracy', 'Accuracy vs profile'],
];

export const VERDICT_LABEL: Record<Critique['verdict'], string> = {
  ready: 'Ready to submit',
  needs_work: 'Needs work',
  not_ready: 'Not ready',
};

function findingsList(findings: CheckFinding[]): HTMLElement {
  const shown = findings.filter((f) => f.severity !== 'info');
  if (!shown.length) return h('p', { class: 'muted' }, 'No problems found by automated checks.');
  return h(
    'ul',
    { class: 'findings' },
    shown.map((f) => h('li', { class: `finding finding-${f.severity}` }, h('span', { class: 'sev' }, f.severity), ' ', f.message)),
  );
}

export class CritiqueTab {
  readonly el = h('div', { class: 'critique-tab scroll' });
  private jobId: string | null = null;
  private critiques: Critique[] = [];
  private busy = false;

  constructor() {
    bus.on('artifact', ({ kind, jobId }) => {
      if (this.jobId && (!jobId || jobId === this.jobId) && (kind === 'critique' || kind === 'cv')) void this.load(this.jobId);
    });
  }

  async load(jobId: string | null): Promise<void> {
    this.jobId = jobId;
    this.critiques = jobId ? await api.critiques(jobId).catch(() => []) : [];
    this.render();
  }

  private async run() {
    if (!this.jobId || this.busy) return;
    this.busy = true;
    this.render();
    try {
      await api.runCritique(this.jobId);
      await this.load(this.jobId);
      bus.emit('artifact', { kind: 'critique', jobId: this.jobId });
    } catch (err) {
      toast((err as Error).message, 'error');
    } finally {
      this.busy = false;
      this.render();
    }
  }

  render() {
    const job = jobById(this.jobId);
    if (!this.jobId || !job) {
      mount(this.el, h('div', { class: 'empty' }, h('h3', null, 'No job selected'), h('p', null, 'Select a job to see its CV critique.')));
      return;
    }
    const runBtn = h('button', { class: 'btn btn-primary btn-sm', disabled: this.busy || !job.hasCv, onclick: () => void this.run() }, this.busy ? 'Critiquing…' : 'Run critique');
    const c = this.critiques.at(-1);
    if (!c) {
      mount(
        this.el,
        h('div', { class: 'empty' }, h('h3', null, 'No critique yet'), h('p', null, job.hasCv ? 'Ask the coach, or run the critic directly.' : 'Write a CV first.'), runBtn),
      );
      return;
    }
    const stale = job.critiqueStale;
    mount(
      this.el,
      h(
        'div',
        { class: 'score-head' },
        h('div', { class: `score-ring score-${c.verdict}` }, h('strong', null, String(c.score)), h('span', null, '/100')),
        h(
          'div',
          { class: 'score-meta' },
          h('span', { class: `badge badge-${c.verdict}` }, VERDICT_LABEL[c.verdict]),
          h('span', { class: 'muted' }, ` ${timeAgo(c.createdAt)}`),
          stale ? h('div', { class: 'stale' }, 'The CV has changed since this critique.') : null,
          this.critiques.length > 1 ? h('div', { class: 'muted history' }, `History: ${this.critiques.map((x) => x.score).join(' → ')}`) : null,
        ),
        h('span', { class: 'spacer' }),
        runBtn,
      ),
      h('p', { class: 'critique-summary' }, c.summary),
      h(
        'div',
        { class: 'dims' },
        DIMENSIONS.map(([key, label]) =>
          h('div', { class: 'dim' }, h('span', { class: 'dim-label' }, label), h('span', { class: 'dim-bar' }, h('span', { style: `width:${c.scores[key] * 10}%` })), h('span', { class: 'dim-val' }, `${c.scores[key]}`)),
        ),
      ),
      c.questionsForCandidate.length
        ? h(
            'section',
            { class: 'card card-accent' },
            h('h4', null, 'Questions for you'),
            h('ul', null, c.questionsForCandidate.map((q) => h('li', null, q))),
            h(
              'button',
              { class: 'btn btn-sm btn-primary', onclick: () => bus.emit('compose', { text: "Let's go through the critic's questions so we can strengthen the CV.", send: true }) },
              'Answer these with the coach',
            ),
          )
        : null,
      c.improvements.length ? h('section', { class: 'card' }, h('h4', null, 'Top improvements'), h('ol', null, c.improvements.map((i) => h('li', null, i)))) : null,
      c.mistakes.length
        ? h(
            'section',
            { class: 'card' },
            h('h4', null, `Mistakes (${c.mistakes.length})`),
            h(
              'ul',
              { class: 'findings' },
              c.mistakes.map((m) =>
                h('li', { class: `finding finding-${m.severity === 'minor' ? 'warning' : 'error'}` }, h('span', { class: 'sev' }, m.severity), ` ${m.location}: ${m.issue} `, h('em', null, `→ ${m.fix}`)),
              ),
            ),
          )
        : null,
      c.factualIssues.length
        ? h(
            'section',
            { class: 'card' },
            h('h4', null, `Accuracy issues (${c.factualIssues.length})`),
            h('ul', { class: 'findings' }, c.factualIssues.map((f) => h('li', { class: 'finding finding-error' }, h('span', { class: 'sev' }, f.problem.replace(/_/g, ' ')), ` “${f.claim}” — ${f.detail}`))),
          )
        : null,
      c.coverage.length
        ? h(
            'section',
            { class: 'card' },
            h('h4', null, 'Job requirement coverage'),
            h(
              'table',
              { class: 'coverage' },
              h('thead', null, h('tr', null, h('th', null, 'Requirement'), h('th', null, 'Status'), h('th', null, 'Evidence / suggestion'))),
              h(
                'tbody',
                null,
                c.coverage.map((r) => h('tr', null, h('td', null, r.requirement), h('td', null, h('span', { class: `status status-${r.status}` }, r.status)), h('td', null, r.evidence ?? '', r.suggestion ? h('div', { class: 'muted' }, r.suggestion) : null))),
              ),
            ),
          )
        : null,
      c.strengths.length ? h('section', { class: 'card' }, h('h4', null, 'Strengths'), h('ul', null, c.strengths.map((s) => h('li', null, s)))) : null,
      h('section', { class: 'card' }, h('h4', null, 'Automated checks'), findingsList(c.checks)),
    );
  }
}
