import { api } from '../api.ts';
import { h, mount, toast } from '../dom.ts';
import { renderMarkdown } from '../markdown.ts';
import type { AgentName, Skill, SkillMeta } from '../types.ts';

const AUDIENCES: AgentName[] = ['coordinator', 'writer', 'critic'];
const AUDIENCE_LABEL: Record<AgentName, string> = { coordinator: 'Coach', writer: 'Writer', critic: 'Critic' };

/** Browse built-in skills and add/edit your own expert advice for the agents. */
export class SkillsTab {
  readonly el = h('div', { class: 'skills-tab' });
  private skills: SkillMeta[] = [];
  private selected: Skill | null = null;
  private editing: (Partial<Skill> & { isNew?: boolean }) | null = null;

  async load(): Promise<void> {
    this.skills = await api.skills();
    this.render();
  }

  private async select(id: string) {
    this.selected = await api.skill(id);
    this.editing = null;
    this.render();
  }

  render() {
    const list = h(
      'div',
      { class: 'skills-list' },
      h('button', { class: 'btn btn-primary btn-sm btn-block', onclick: () => ((this.editing = { isNew: true, audience: [...AUDIENCES], tags: [], autoload: false }), this.render()) }, '+ New skill'),
      this.skills.map((s) =>
        h(
          'button',
          { class: `skill-item${this.selected?.id === s.id ? ' active' : ''}`, onclick: () => void this.select(s.id) },
          h('span', { class: 'skill-name' }, s.name),
          h('span', { class: 'skill-tags' }, s.source === 'user' ? h('span', { class: 'badge badge-accent' }, s.overridesBuiltin ? 'custom override' : 'custom') : null, s.autoload ? h('span', { class: 'badge badge-muted' }, 'always on') : null),
        ),
      ),
    );
    mount(this.el, list, h('div', { class: 'skill-detail scroll' }, this.editing ? this.form() : this.detail()));
  }

  private detail(): HTMLElement {
    const s = this.selected;
    if (!s) {
      return h(
        'div',
        { class: 'empty' },
        h('h3', null, 'Skills library'),
        h('p', null, 'Expert CV-writing and critique advice the agents can read. Skills marked “always on” are loaded into the agent’s instructions; others are listed and read on demand.'),
      );
    }
    return h(
      'div',
      null,
      h(
        'div',
        { class: 'doc-head' },
        h('div', null, h('h2', null, s.name), h('div', { class: 'muted' }, s.description)),
        h('span', { class: 'spacer' }),
        h('button', { class: 'btn btn-sm', onclick: () => ((this.editing = { ...s }), this.render()) }, s.source === 'builtin' ? 'Customise' : 'Edit'),
        s.source === 'user' ? h('button', { class: 'btn btn-sm btn-danger-ghost', onclick: () => void this.remove(s) }, s.overridesBuiltin ? 'Revert to built-in' : 'Delete') : null,
      ),
      h('div', { class: 'skill-meta' }, `Used by: ${s.audience.map((a) => AUDIENCE_LABEL[a]).join(', ')}`, s.tags.length ? ` · Tags: ${s.tags.join(', ')}` : '', ` · id: ${s.id}`),
      h('article', { class: 'md doc', html: renderMarkdown(s.body) }),
    );
  }

  private form(): HTMLElement {
    const e = this.editing!;
    const name = h('input', { class: 'input', value: e.name ?? '', placeholder: 'Name', required: true });
    const description = h('input', { class: 'input', value: e.description ?? '', placeholder: 'One-line description (shown to agents in the skill index)' });
    const tags = h('input', { class: 'input', value: (e.tags ?? []).join(', '), placeholder: 'Tags, comma separated' });
    const body = h('textarea', { class: 'input code-editor tall', placeholder: 'Markdown advice for the agents…' });
    body.value = e.body ?? '';
    const audience = AUDIENCES.map((a) => h('input', { type: 'checkbox', value: a, checked: (e.audience ?? []).includes(a) }));
    const autoload = h('input', { type: 'checkbox', checked: Boolean(e.autoload) });
    return h(
      'form',
      {
        class: 'form',
        onsubmit: async (ev: SubmitEvent) => {
          ev.preventDefault();
          const input = {
            name: name.value.trim(),
            description: description.value.trim(),
            tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean),
            audience: audience.filter((c) => c.checked).map((c) => c.value as AgentName),
            autoload: autoload.checked,
            body: body.value,
          };
          try {
            this.selected = e.isNew ? await api.createSkill(input) : await api.updateSkill(e.id!, input);
            this.editing = null;
            await this.load();
            toast('Skill saved.');
          } catch (err) {
            toast((err as Error).message, 'error');
          }
        },
      },
      h('h2', null, e.isNew ? 'New skill' : `Edit “${e.name}”`),
      e.source === 'builtin' ? h('p', { class: 'muted' }, 'Saving creates your own version that overrides the built-in skill. You can revert it later.') : null,
      name,
      description,
      h('div', { class: 'form-row checks' }, h('span', null, 'Used by:'), AUDIENCES.map((a, i) => h('label', null, audience[i], ` ${AUDIENCE_LABEL[a]}`)), h('label', { title: 'Load the full text into the agent instructions every time' }, autoload, ' Always on')),
      tags,
      body,
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => ((this.editing = null), this.render()) }, 'Cancel'),
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save skill'),
      ),
    );
  }

  private async remove(s: Skill) {
    if (!confirm(s.overridesBuiltin ? `Revert "${s.name}" to the built-in version?` : `Delete "${s.name}"?`)) return;
    try {
      await api.deleteSkill(s.id);
      this.selected = s.overridesBuiltin ? await api.skill(s.id) : null;
      await this.load();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }
}
