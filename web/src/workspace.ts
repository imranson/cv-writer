import { h, mount } from './dom.ts';
import { activeJobId, bus, jobById } from './state.ts';
import { CritiqueTab } from './tabs/critiqueTab.ts';
import { CvTab } from './tabs/cvTab.ts';
import { JobTab } from './tabs/jobTab.ts';
import { ProfileTab } from './tabs/profileTab.ts';
import { SkillsTab } from './tabs/skillsTab.ts';

type TabId = 'cv' | 'critique' | 'job' | 'profile' | 'skills';

const TAB_LABELS: Record<TabId, string> = {
  cv: 'CV',
  critique: 'Critique',
  job: 'Job listing',
  profile: 'Profile',
  skills: 'Skills',
};

/** Right-hand panel: everything the agents produce, viewable and editable by the user. */
export class Workspace {
  readonly el: HTMLElement;
  private readonly tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  private readonly jobLabel = h('div', { class: 'ws-job' });
  private readonly content = h('div', { class: 'ws-content' });
  private readonly cv = new CvTab();
  private readonly critique = new CritiqueTab();
  private readonly job = new JobTab();
  private readonly profile = new ProfileTab();
  private readonly skills = new SkillsTab();
  private active: TabId = 'cv';
  private jobId: string | null = null;

  constructor() {
    this.el = h('section', { class: 'workspace' }, h('header', { class: 'ws-header' }, this.tabsEl, this.jobLabel), this.content);
    bus.on('session', () => void this.syncJob());
    bus.on('jobs', () => {
      this.renderJobLabel();
      if (this.active === 'critique') this.critique.render();
    });
    bus.on('tab', (tab) => {
      if (tab === 'job:new') {
        this.show('job');
        this.job.startNew();
      } else this.show(tab as TabId);
    });
    bus.on('artifact', ({ kind }) => {
      // Point the user at what just changed without pulling them away from what they are editing.
      if (kind === 'cv' && this.active !== 'cv') this.flag('cv');
      if (kind === 'critique' && this.active !== 'critique') this.flag('critique');
      if (kind === 'profile' && this.active !== 'profile') this.flag('profile');
    });
    this.renderTabs();
  }

  private flag(tab: TabId) {
    this.tabsEl.querySelector(`[data-tab="${tab}"]`)?.classList.add('flag');
  }

  private renderTabs() {
    mount(
      this.tabsEl,
      (Object.keys(TAB_LABELS) as TabId[]).map((id) =>
        h('button', { class: `tab${this.active === id ? ' active' : ''}`, role: 'tab', 'aria-selected': String(this.active === id), dataset: { tab: id }, onclick: () => this.show(id) }, TAB_LABELS[id]),
      ),
    );
  }

  private renderJobLabel() {
    const job = jobById(this.jobId);
    this.jobLabel.textContent = job ? `${job.title} — ${job.company}` : '';
  }

  show(tab: TabId) {
    this.active = tab;
    this.renderTabs();
    const views: Record<TabId, HTMLElement> = { cv: this.cv.el, critique: this.critique.el, job: this.job.el, profile: this.profile.el, skills: this.skills.el };
    mount(this.content, views[tab]);
    if (tab === 'profile') void this.profile.load();
    if (tab === 'skills') void this.skills.load();
    if (tab === 'critique') this.critique.render();
  }

  async syncJob(): Promise<void> {
    const jobId = activeJobId();
    this.renderJobLabel();
    if (jobId === this.jobId) return;
    this.jobId = jobId;
    this.renderJobLabel();
    await Promise.all([this.cv.setJob(jobId), this.critique.load(jobId), this.job.load(jobId)]);
  }

  async init(): Promise<void> {
    this.show('cv');
    await this.syncJob();
    await this.cv.load(this.jobId);
  }
}
