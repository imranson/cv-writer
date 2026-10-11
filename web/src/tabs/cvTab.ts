import { buildCvDocument, parsePageBox } from '../../../src/cv/document.ts';
import { api } from '../api.ts';
import { getCssVar, getPageSize, lengthToPx, parsePt, setCssVar, setPageSize, toHexColour } from '../cssvars.ts';
import { debounce, h, mount, timeAgo, toast } from '../dom.ts';
import { bus, jobById } from '../state.ts';
import type { CvVersion, StylePreset } from '../types.ts';

type EditMode = 'none' | 'css' | 'html';
type ViewMode = 'html' | 'pdf';

/** The CV tab: live preview, exact PDF view, raw CSS/HTML editors, quick style controls and version history. */
export class CvTab {
  readonly el: HTMLElement;
  private jobId: string | null = null;
  private html = '';
  private css = '';
  private draftCss: string | null = null;
  private draftHtml: string | null = null;
  private mode: EditMode = 'none';
  private view: ViewMode = 'html';
  private presets: StylePreset[] = [];
  private versions: CvVersion[] = [];
  private viewingVersion: { id: string; html: string } | null = null;

  private readonly toolbar = h('div', { class: 'toolbar' });
  private readonly editorPane = h('div', { class: 'editor-pane', hidden: true });
  private readonly editor = h('textarea', { class: 'code-editor', spellcheck: false, 'aria-label': 'Editor' });
  private readonly editorHeader = h('div', { class: 'editor-header' });
  private readonly quick = h('div', { class: 'quick-controls' });
  private readonly frame = h('iframe', { class: 'preview-frame', title: 'CV preview', sandbox: 'allow-same-origin' });
  private readonly pdfFrame = h('iframe', { class: 'preview-frame', title: 'CV PDF', hidden: true });
  private readonly banner = h('div', { class: 'banner', hidden: true });
  private readonly empty = h('div', { class: 'empty', hidden: true });
  private readonly pageBadge = h('span', { class: 'badge badge-muted', title: 'Pages in the rendered PDF', hidden: true });
  private readonly refreshPreview = debounce(() => this.renderPreview(), 200);
  private readonly refreshPages = debounce(() => void this.updatePages(), 600);

  constructor() {
    this.el = h(
      'div',
      { class: 'cv-tab' },
      this.toolbar,
      this.banner,
      h('div', { class: 'cv-body' }, this.editorPane, h('div', { class: 'preview-wrap' }, this.empty, this.frame, this.pdfFrame)),
    );
    mount(this.editorPane, this.editorHeader, this.quick, this.editor);
    this.frame.addEventListener('load', () => this.fit());
    new ResizeObserver(() => this.fit()).observe(this.frame);

    this.editor.addEventListener('input', () => {
      if (this.mode === 'css') this.draftCss = this.editor.value;
      if (this.mode === 'html') this.draftHtml = this.editor.value;
      this.renderEditorHeader();
      this.renderQuick();
      this.refreshPreview();
    });
    this.editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        this.editor.setRangeText('  ', this.editor.selectionStart, this.editor.selectionEnd, 'end');
        this.editor.dispatchEvent(new Event('input'));
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        void this.save();
      }
    });

    bus.on('artifact', ({ kind, jobId }) => {
      if (!this.jobId || (jobId && jobId !== this.jobId)) return;
      if (kind === 'cv' && this.draftHtml === null) void this.load(this.jobId, true);
      else if (kind === 'style' && this.draftCss === null) void this.load(this.jobId, true);
      else if (kind === 'cv' || kind === 'style') toast(`The assistant changed the ${kind === 'cv' ? 'CV' : 'stylesheet'}; your unsaved edits were kept.`);
    });
  }

  get dirty(): boolean {
    return (this.draftCss !== null && this.draftCss !== this.css) || (this.draftHtml !== null && this.draftHtml !== this.html);
  }

  async setJob(jobId: string | null): Promise<void> {
    if (jobId === this.jobId) return;
    if (this.dirty && !confirm('Discard unsaved CV/CSS edits?')) return;
    this.draftCss = this.draftHtml = null;
    this.viewingVersion = null;
    this.mode = 'none';
    await this.load(jobId);
  }

  async load(jobId: string | null, keepMode = false): Promise<void> {
    this.jobId = jobId;
    if (!keepMode) this.view = 'html';
    if (!jobId) {
      this.html = this.css = '';
      this.render();
      return;
    }
    const [cv, style, versions] = await Promise.all([api.cv(jobId), api.style(jobId), api.versions(jobId)]);
    if (!this.presets.length) this.presets = await api.presets();
    if (jobId !== this.jobId) return;
    this.html = cv.html;
    this.css = style.css;
    this.versions = versions;
    this.render();
    if (this.html.trim()) this.refreshPages();
  }

  private currentCss() {
    return this.draftCss ?? this.css;
  }

  private currentHtml() {
    return this.viewingVersion?.html ?? this.draftHtml ?? this.html;
  }

  render() {
    const hasCv = Boolean(this.html.trim() || this.draftHtml?.trim());
    this.toolbar.hidden = !hasCv;
    this.renderToolbar(hasCv);
    this.empty.hidden = hasCv;
    if (!hasCv) {
      const job = jobById(this.jobId);
      mount(
        this.empty,
        job
          ? [
              h('h3', null, 'No CV yet'),
              h('p', null, `Once your profile has enough detail, the coach will draft a CV tailored to ${job.title} at ${job.company}.`),
              h('button', { class: 'btn btn-primary', onclick: () => bus.emit('compose', { text: 'Please draft my CV for this job.', send: true }) }, 'Ask the coach to draft it'),
            ]
          : [h('h3', null, 'No job selected'), h('p', null, 'Paste a job listing into the chat, or pick a job on the left, to start a CV.')],
      );
    }
    this.frame.hidden = !hasCv || this.view === 'pdf';
    this.pdfFrame.hidden = !hasCv || this.view !== 'pdf';
    this.editorPane.hidden = this.mode === 'none' || !hasCv;
    if (this.mode !== 'none') {
      this.editor.value = this.mode === 'css' ? this.currentCss() : (this.draftHtml ?? this.html);
      this.renderEditorHeader();
      this.renderQuick();
    }
    this.renderBanner();
    if (hasCv) {
      if (this.view === 'pdf' && this.jobId) this.pdfFrame.src = api.pdfUrl(this.jobId);
      else this.renderPreview();
    }
  }

  private renderToolbar(hasCv: boolean) {
    const seg = (label: string, active: boolean, onclick: () => void, title = '') => h('button', { class: `seg${active ? ' active' : ''}`, onclick, title }, label);
    mount(
      this.toolbar,
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'View' },
        seg('Preview', this.view === 'html', () => this.setView('html'), 'Live HTML preview (updates as you edit)'),
        seg('PDF', this.view === 'pdf', () => this.setView('pdf'), 'Exact PDF rendering (saved version)'),
      ),
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Edit' },
        seg('Edit CSS', this.mode === 'css', () => this.setMode('css'), 'Edit the raw stylesheet'),
        seg('Edit HTML', this.mode === 'html', () => this.setMode('html'), 'Edit the raw CV markup'),
      ),
      h(
        'select',
        {
          class: 'select-sm',
          'aria-label': 'Apply style preset',
          disabled: !hasCv,
          onchange: (e: Event) => {
            const sel = e.target as HTMLSelectElement;
            const preset = this.presets.find((p) => p.id === sel.value);
            sel.value = '';
            if (preset) this.applyPreset(preset);
          },
        },
        h('option', { value: '' }, 'Preset…'),
        this.presets.map((p) => h('option', { value: p.id, title: p.description }, p.name)),
      ),
      h(
        'select',
        {
          class: 'select-sm',
          'aria-label': 'Version history',
          disabled: !this.versions.length,
          onchange: (e: Event) => void this.viewVersion((e.target as HTMLSelectElement).value),
        },
        h('option', { value: '' }, this.versions.length ? `History (${this.versions.length})` : 'History'),
        this.versions.map((v, i) => h('option', { value: v.id, selected: this.viewingVersion?.id === v.id }, `${i === 0 ? 'Current · ' : ''}${timeAgo(v.createdAt)} · ${v.source}`)),
      ),
      h('span', { class: 'spacer' }),
      this.pageBadge,
      hasCv && this.jobId ? h('a', { class: 'btn btn-primary btn-sm', href: api.pdfUrl(this.jobId, true), download: '', 'aria-label': 'Download PDF', title: 'Download PDF' }, '⬇ PDF') : null,
    );
  }

  private renderBanner() {
    if (this.viewingVersion) {
      this.banner.hidden = false;
      mount(
        this.banner,
        h('span', null, 'Viewing an earlier version.'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => void this.restoreVersion() }, 'Restore this version'),
        h('button', { class: 'btn btn-sm btn-ghost', onclick: () => this.exitVersion() }, 'Back to current'),
      );
    } else if (this.view === 'pdf' && this.dirty) {
      this.banner.hidden = false;
      mount(this.banner, 'The PDF shows the saved version — save your edits to update it.');
    } else {
      this.banner.hidden = true;
    }
  }

  private renderEditorHeader() {
    const file = this.mode === 'css' ? 'style.css' : 'cv.html';
    mount(
      this.editorHeader,
      h('span', { class: 'editor-file' }, file, this.dirty ? h('span', { class: 'dirty-dot', title: 'Unsaved changes' }, ' ●') : null),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn btn-sm btn-ghost', disabled: !this.dirty, onclick: () => this.discard() }, 'Discard'),
      h('button', { class: 'btn btn-sm btn-primary', disabled: !this.dirty, onclick: () => void this.save() }, 'Save'),
    );
  }

  /** Quick controls edit CSS variables / @page in the raw CSS. */
  private renderQuick() {
    if (this.mode !== 'css') {
      this.quick.hidden = true;
      return;
    }
    this.quick.hidden = false;
    const css = this.currentCss();
    const accent = toHexColour(getCssVar(css, 'accent'));
    const size = parsePt(getCssVar(css, 'base-size'));
    const page = (getPageSize(css) ?? 'A4').split(/\s+/)[0]?.toLowerCase();
    const update = (next: string) => {
      this.draftCss = next;
      this.editor.value = next;
      this.renderEditorHeader();
      this.refreshPreview();
    };
    mount(
      this.quick,
      accent
        ? h('label', null, 'Accent ', h('input', { type: 'color', value: accent, oninput: (e: Event) => update(setCssVar(this.currentCss(), 'accent', (e.target as HTMLInputElement).value)) }))
        : null,
      size
        ? h(
            'label',
            null,
            'Text size ',
            h('input', {
              type: 'range',
              min: '8',
              max: '12',
              step: '0.1',
              value: String(size),
              oninput: (e: Event) => {
                const v = Number((e.target as HTMLInputElement).value).toFixed(1);
                update(setCssVar(this.currentCss(), 'base-size', `${v}pt`));
                (e.target as HTMLElement).nextElementSibling!.textContent = `${v}pt`;
              },
            }),
            h('span', { class: 'quick-value' }, `${size}pt`),
          )
        : null,
      h(
        'label',
        null,
        'Page ',
        h(
          'select',
          { class: 'select-sm', onchange: (e: Event) => update(setPageSize(this.currentCss(), (e.target as HTMLSelectElement).value)) },
          ['A4', 'Letter'].map((p) => h('option', { value: p, selected: page === p.toLowerCase() }, p)),
        ),
      ),
    );
  }

  private renderPreview() {
    const doc = buildCvDocument({ html: this.currentHtml(), css: this.currentCss(), preview: true });
    this.frame.srcdoc = doc;
  }

  /** Scales the paper-sized preview to fit the panel width. */
  private fit() {
    const doc = this.frame.contentDocument;
    if (!doc?.documentElement || this.frame.hidden) return;
    const pageWidth = lengthToPx(parsePageBox(this.currentCss()).width) + 48;
    const scale = Math.min(1, (this.frame.clientWidth - 8) / pageWidth);
    doc.documentElement.style.setProperty('zoom', String(Math.max(scale, 0.3)));
  }

  private setView(view: ViewMode) {
    this.view = view;
    this.render();
  }

  private setMode(mode: EditMode) {
    if (this.mode === mode) mode = 'none';
    this.mode = mode;
    if (mode !== 'none') this.view = 'html';
    this.render();
    if (mode !== 'none') {
      this.editor.setSelectionRange(0, 0);
      this.editor.scrollTop = 0;
      this.editor.focus({ preventScroll: true });
    }
  }

  private applyPreset(preset: StylePreset) {
    if (this.draftCss !== null && this.draftCss !== this.css && !confirm('Replace your unsaved CSS with the preset?')) return;
    this.draftCss = preset.css;
    this.mode = 'css';
    this.view = 'html';
    this.render();
    toast(`Applied "${preset.name}" — review and press Save to keep it.`);
  }

  private discard() {
    if (this.mode === 'css') this.draftCss = null;
    if (this.mode === 'html') this.draftHtml = null;
    this.render();
  }

  async save(): Promise<void> {
    if (!this.jobId) return;
    try {
      if (this.draftCss !== null && this.draftCss !== this.css) {
        this.css = (await api.saveStyle(this.jobId, this.draftCss)).css;
      }
      this.draftCss = null;
      if (this.draftHtml !== null && this.draftHtml !== this.html) {
        this.html = (await api.saveCv(this.jobId, this.draftHtml)).html;
        this.versions = await api.versions(this.jobId);
      }
      this.draftHtml = null;
      toast('Saved.');
      this.render();
      this.refreshPages();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  }

  private async viewVersion(id: string) {
    if (!this.jobId) return;
    if (!id || id === this.versions[0]?.id) {
      this.exitVersion();
      return;
    }
    const { html } = await api.version(this.jobId, id);
    this.viewingVersion = { id, html };
    this.view = 'html';
    this.render();
  }

  private exitVersion() {
    this.viewingVersion = null;
    this.render();
  }

  private async restoreVersion() {
    if (!this.jobId || !this.viewingVersion) return;
    await api.restoreVersion(this.jobId, this.viewingVersion.id);
    this.viewingVersion = null;
    toast('Version restored.');
    await this.load(this.jobId, true);
    bus.emit('artifact', { kind: 'cv', jobId: this.jobId });
  }

  private async updatePages() {
    if (!this.jobId) return;
    try {
      const { pageCount, findings } = await api.checks(this.jobId);
      const errors = findings.filter((f) => f.severity === 'error').length;
      this.pageBadge.hidden = false;
      this.pageBadge.textContent = `${pageCount ?? '?'} page${pageCount === 1 ? '' : 's'}${errors ? ` · ${errors} issue${errors === 1 ? '' : 's'}` : ''}`;
      this.pageBadge.className = `badge ${errors ? 'badge-not_ready' : 'badge-muted'}`;
      this.pageBadge.title = findings
        .filter((f) => f.severity !== 'info')
        .map((f) => `${f.severity}: ${f.message}`)
        .join('\n') || 'No problems found by automated checks';
    } catch {
      this.pageBadge.hidden = true;
    }
  }
}
