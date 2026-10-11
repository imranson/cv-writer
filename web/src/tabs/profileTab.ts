import { api } from '../api.ts';
import { h, mount, toast } from '../dom.ts';
import { renderMarkdown } from '../markdown.ts';
import { bus } from '../state.ts';

/** The candidate profile (markdown): rendered view plus a raw editor. */
export class ProfileTab {
  readonly el = h('div', { class: 'profile-tab scroll' });
  private markdown = '';
  private draft: string | null = null;

  constructor() {
    bus.on('artifact', ({ kind }) => {
      if (kind !== 'profile') return;
      if (this.draft === null) void this.load();
      else toast('The coach updated your profile; your unsaved edits were kept.');
    });
  }

  async load(): Promise<void> {
    this.markdown = (await api.profile()).markdown;
    this.render();
  }

  render() {
    if (this.draft !== null) {
      const editor = h('textarea', { class: 'input code-editor tall', 'aria-label': 'Profile markdown' });
      editor.value = this.draft;
      editor.addEventListener('input', () => (this.draft = editor.value));
      mount(
        this.el,
        h(
          'div',
          { class: 'doc-head' },
          h('h2', null, 'Edit profile'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn btn-sm btn-ghost', onclick: () => ((this.draft = null), this.render()) }, 'Cancel'),
          h('button', { class: 'btn btn-sm btn-primary', onclick: () => void this.save() }, 'Save'),
        ),
        h('p', { class: 'muted' }, 'Markdown. This is the source of truth for every fact on your CVs; keep preferences under “## Preferences”.'),
        editor,
      );
      editor.focus();
      return;
    }
    mount(
      this.el,
      h(
        'div',
        { class: 'doc-head' },
        h('h2', null, 'Your profile'),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', onclick: () => ((this.draft = this.markdown), this.render()) }, 'Edit'),
      ),
      this.markdown.trim()
        ? h('article', { class: 'md doc', html: renderMarkdown(this.markdown) })
        : h(
            'div',
            { class: 'empty' },
            h('h3', null, 'Your profile is empty'),
            h('p', null, 'The coach will interview you to build it — or paste your existing CV into the chat.'),
            h('button', { class: 'btn btn-primary', onclick: () => bus.emit('compose', { text: "Let's build my profile. Please interview me.", send: true }) }, 'Start the interview'),
          ),
    );
  }

  private async save() {
    if (this.draft === null) return;
    try {
      this.markdown = (await api.saveProfile(this.draft)).markdown;
      this.draft = null;
      this.render();
      toast('Profile saved.');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
}
