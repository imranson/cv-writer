import { deleteSession, openSession, setSessionJob } from './actions.ts';
import { h, mount, timeAgo } from './dom.ts';
import { bus, jobById, state } from './state.ts';
import type { JobSummary } from './types.ts';

export function scoreBadge(job: Pick<JobSummary, 'hasCv' | 'score' | 'verdict' | 'critiqueStale'>): HTMLElement {
  if (!job.hasCv) return h('span', { class: 'badge badge-muted' }, 'no CV');
  if (job.score === undefined) return h('span', { class: 'badge badge-muted' }, 'draft');
  return h(
    'span',
    { class: `badge badge-${job.verdict ?? 'needs_work'}`, title: job.critiqueStale ? 'The CV changed since this score' : `Verdict: ${job.verdict?.replace('_', ' ')}` },
    `${job.score}${job.critiqueStale ? '*' : ''}`,
  );
}

export class Sidebar {
  readonly el: HTMLElement;
  private readonly sessionsEl = h('nav', { class: 'side-list', 'aria-label': 'Conversations' });
  private readonly jobsEl = h('nav', { class: 'side-list', 'aria-label': 'Jobs' });
  private readonly footer = h('div', { class: 'side-footer' });

  constructor() {
    this.el = h(
      'aside',
      { class: 'sidebar' },
      h('div', { class: 'brand' }, h('span', { class: 'brand-mark' }, 'CV'), h('span', null, 'Writer')),
      h('button', { class: 'btn btn-primary btn-block', onclick: () => void openSession(null) }, '+ New conversation'),
      h('div', { class: 'side-heading' }, 'Conversations'),
      this.sessionsEl,
      h(
        'div',
        { class: 'side-heading' },
        'Jobs',
        h('button', { class: 'icon-btn', title: 'Add a job listing', onclick: () => bus.emit('tab', 'job:new') }, '+'),
      ),
      this.jobsEl,
      h(
        'div',
        { class: 'side-links' },
        h('button', { class: 'side-link', onclick: () => bus.emit('tab', 'profile') }, '👤 Profile'),
        h('button', { class: 'side-link', onclick: () => bus.emit('tab', 'skills') }, '📚 Skills library'),
      ),
      this.footer,
    );
    bus.on('sessions', () => this.renderSessions());
    bus.on('session', () => {
      this.renderSessions();
      this.renderJobs();
    });
    bus.on('jobs', () => this.renderJobs());
  }

  renderSessions() {
    if (!state.sessions.length) {
      mount(this.sessionsEl, h('p', { class: 'side-empty' }, 'No conversations yet.'));
      return;
    }
    mount(
      this.sessionsEl,
      state.sessions.map((s) =>
        h(
          'div',
          { class: `side-item${state.session?.id === s.id ? ' active' : ''}`, onclick: () => void openSession(s.id), title: s.title },
          h('div', { class: 'side-item-main' }, h('span', { class: 'side-item-title' }, s.title), h('span', { class: 'side-item-sub' }, `${jobById(s.jobId)?.company ?? 'No job'} · ${timeAgo(s.updatedAt)}`)),
          h(
            'button',
            {
              class: 'icon-btn side-item-delete',
              title: 'Delete conversation',
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                if (confirm(`Delete "${s.title}"?`)) void deleteSession(s.id);
              },
            },
            '×',
          ),
        ),
      ),
    );
  }

  renderJobs() {
    if (!state.jobs.length) {
      mount(this.jobsEl, h('p', { class: 'side-empty' }, 'No jobs yet — paste a listing in the chat.'));
      return;
    }
    mount(
      this.jobsEl,
      state.jobs.map((j) =>
        h(
          'div',
          { class: `side-item${state.session?.jobId === j.id ? ' active' : ''}`, onclick: () => void setSessionJob(j.id), title: `${j.title} — ${j.company}` },
          h('div', { class: 'side-item-main' }, h('span', { class: 'side-item-title' }, j.title), h('span', { class: 'side-item-sub' }, j.company)),
          scoreBadge(j),
        ),
      ),
    );
  }

  renderFooter() {
    const info = state.info;
    if (!info) return;
    mount(this.footer, h('div', { title: info.host ?? '' }, `Model: ${info.models.coordinator}`));
  }
}
