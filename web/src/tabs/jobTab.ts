import { refreshJobs, setSessionJob } from '../actions.ts';
import { api } from '../api.ts';
import { h, mount, toast } from '../dom.ts';
import { renderMarkdown } from '../markdown.ts';
import { bus, state } from '../state.ts';
import type { Job } from '../types.ts';

/** View/edit the active job listing, or create a new one. */
export class JobTab {
  readonly el = h('div', { class: 'job-tab scroll' });
  private job: Job | null = null;
  private creating = false;
  private editing = false;

  constructor() {
    bus.on('artifact', ({ kind, jobId }) => {
      if (kind === 'job' && this.job && jobId === this.job.id && !this.editing) void this.load(this.job.id);
    });
  }

  async load(jobId: string | null): Promise<void> {
    this.creating = false;
    this.editing = false;
    this.job = jobId ? await api.job(jobId).catch(() => null) : null;
    this.render();
  }

  startNew() {
    this.creating = true;
    this.editing = true;
    this.render();
  }

  render() {
    if (this.editing) {
      this.renderForm();
      return;
    }
    if (!this.job) {
      mount(
        this.el,
        h(
          'div',
          { class: 'empty' },
          h('h3', null, 'No job selected'),
          h('p', null, 'Paste a job listing (or a URL) into the chat and the coach will save it, or add one yourself.'),
          h('button', { class: 'btn btn-primary', onclick: () => this.startNew() }, 'Add a job listing'),
        ),
      );
      return;
    }
    const job = this.job;
    mount(
      this.el,
      h(
        'div',
        { class: 'doc-head' },
        h('div', null, h('h2', null, job.title), h('div', { class: 'muted' }, job.company, job.url ? [' · ', h('a', { href: job.url, target: '_blank', rel: 'noopener noreferrer' }, 'original listing')] : null)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.startNew() }, 'New job'),
        h('button', { class: 'btn btn-sm', onclick: () => ((this.editing = true), this.render()) }, 'Edit'),
        h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => void this.remove() }, 'Delete'),
      ),
      h('article', { class: 'md doc', html: renderMarkdown(job.listing) }),
    );
  }

  private renderForm() {
    const job = this.creating ? null : this.job;
    const title = h('input', { class: 'input', value: job?.title ?? '', placeholder: 'Job title', required: true });
    const company = h('input', { class: 'input', value: job?.company ?? '', placeholder: 'Company', required: true });
    const url = h('input', { class: 'input', value: job?.url ?? '', placeholder: 'Listing URL (optional)' });
    const listing = h('textarea', { class: 'input code-editor tall', placeholder: 'Paste the full job listing here (markdown is fine)…' });
    listing.value = job?.listing ?? '';
    const form = h(
      'form',
      {
        class: 'form',
        onsubmit: async (e: SubmitEvent) => {
          e.preventDefault();
          const input = { title: title.value.trim(), company: company.value.trim(), url: url.value.trim() || undefined, listing: listing.value };
          if (!input.title || !input.company) return toast('Title and company are required.', 'error');
          try {
            if (this.creating) {
              const created = await api.createJob(input);
              await refreshJobs();
              await setSessionJob(created.id);
              this.job = created;
            } else if (job) {
              this.job = await api.updateJob(job.id, input);
              await refreshJobs();
            }
            this.creating = this.editing = false;
            this.render();
            toast('Job saved.');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        },
      },
      h('h2', null, this.creating ? 'Add a job listing' : 'Edit job listing'),
      h('div', { class: 'form-row' }, title, company),
      url,
      listing,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ((this.creating = this.editing = false), this.render()) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save'),
      ),
    );
    mount(this.el, form);
    title.focus();
  }

  private async remove() {
    if (!this.job || !confirm(`Delete "${this.job.title}" and its CV? This cannot be undone.`)) return;
    try {
      await api.deleteJob(this.job.id);
      if (state.session?.jobId === this.job.id) await setSessionJob(null);
      this.job = null;
      await refreshJobs();
      this.render();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
}
