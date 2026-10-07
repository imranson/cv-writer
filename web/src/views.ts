import { api, type AppConfigView, type AuditRecord, type Check, type CheckReport, type CvVersion, type HistoryRecord, type Job, type Profile, type Style, type VersionSummary } from './api.js';
import { formatTime, h } from './dom.js';

const SECTION_LABELS: Record<string, string> = {
  experience: 'Experience',
  education: 'Education',
  project: 'Projects',
  certification: 'Certifications',
  award: 'Awards',
  publication: 'Publications',
  volunteering: 'Volunteering',
  other: 'Other',
};

function empty(text: string): HTMLElement {
  return h('p', { class: 'empty' }, text);
}

export function profileView(profile: Profile, gaps: string[], history: HistoryRecord[]): HTMLElement {
  const c = profile.contact;
  const root = h('div', { class: 'doc' });
  root.append(
    h('div', { class: 'doc-head' }, h('h2', {}, c.name ?? 'Your profile'), h('span', { class: 'muted' }, `revision ${profile.revision}`)),
    h('p', { class: 'muted' }, [c.email, c.phone, c.location, ...c.links].filter(Boolean).join(' · ') || 'No contact details yet.'),
  );
  if (profile.headline) root.append(h('p', {}, h('strong', {}, 'Career goal: '), profile.headline));
  if (!profile.entries.length && !profile.skills.length) root.append(empty('Nothing saved yet — your coach will build this up as you talk.'));

  const sections = Object.keys(SECTION_LABELS).filter((s) => profile.entries.some((e) => e.section === s));
  for (const section of sections) {
    root.append(h('h3', {}, SECTION_LABELS[section]!));
    for (const e of profile.entries.filter((x) => x.section === section)) {
      root.append(
        h(
          'div',
          { class: 'entry' },
          h(
            'div',
            { class: 'entry-head' },
            h('span', {}, h('strong', {}, e.title), e.organisation ? `, ${e.organisation}` : ''),
            h('span', { class: 'muted' }, [e.location, [e.startDate, e.endDate].filter(Boolean).join(' – ')].filter(Boolean).join(' · ')),
          ),
          e.summary ? h('p', {}, e.summary) : null,
          e.highlights.length ? h('ul', {}, ...e.highlights.map((x) => h('li', {}, x))) : null,
          e.skills.length ? h('p', { class: 'chips' }, ...e.skills.map((s) => h('span', { class: 'chip' }, s))) : null,
          h('code', { class: 'entry-id', title: 'Entry id (CVs cite this)' }, e.id),
        ),
      );
    }
  }
  if (profile.skills.length) {
    root.append(h('h3', {}, 'Skills'));
    for (const g of profile.skills) root.append(h('p', {}, h('strong', {}, `${g.category}: `), g.items.join(', ')));
  }
  if (profile.facts.length) root.append(h('h3', {}, 'Other facts'), h('ul', {}, ...profile.facts.map((f) => h('li', {}, f))));
  if (gaps.length)
    root.append(
      h('h3', {}, 'Gaps your coach will ask about'),
      h('ul', { class: 'gaps' }, ...gaps.map((g) => h('li', {}, g))),
    );
  if (history.length) {
    root.append(h('h3', {}, 'Change history'));
    root.append(
      h(
        'ol',
        { class: 'timeline' },
        ...history.slice(0, 50).map((r) =>
          h('li', {}, h('span', { class: 'muted' }, `r${r.revision} · ${formatTime(r.at)} · ${r.actor ?? 'app'}`), ' ', h('strong', {}, r.operation.replace(/_/g, ' ')), r.reason ? ` — ${r.reason}` : ''),
        ),
      ),
    );
  }
  return root;
}

export function jobView(job: Job | undefined): HTMLElement {
  if (!job) return h('div', { class: 'doc' }, empty('No job listing yet. Paste one into the chat, or give your coach a link.'));
  return h(
    'div',
    { class: 'doc' },
    h('div', { class: 'doc-head' }, h('h2', {}, job.title), h('span', { class: 'muted' }, `saved ${formatTime(job.createdAt)}`)),
    h('p', {}, h('strong', {}, job.company), job.location ? ` · ${job.location}` : '', job.url ? h('span', {}, ' · ', h('a', { href: job.url, target: '_blank', rel: 'noopener' }, 'original listing')) : ''),
    job.requirements.length ? h('div', {}, h('h3', {}, 'Key requirements'), h('ul', {}, ...job.requirements.map((r) => h('li', {}, r)))) : null,
    job.keywords.length ? h('div', {}, h('h3', {}, 'Keywords'), h('p', { class: 'chips' }, ...job.keywords.map((k) => h('span', { class: 'chip' }, k)))) : null,
    job.notes ? h('p', {}, h('strong', {}, 'Notes: '), job.notes) : null,
    h('h3', {}, 'Listing (verbatim)'),
    h('pre', { class: 'listing' }, job.description),
  );
}

function checkList(checks: Check[]): HTMLElement {
  if (!checks.length) return h('p', { class: 'ok' }, 'All automatic checks passed.');
  return h(
    'ul',
    { class: 'checks' },
    ...checks.map((c) => h('li', { class: `sev-${c.severity}` }, h('span', { class: 'sev' }, c.severity), ' ', c.location ? h('span', { class: 'muted' }, `${c.location}: `) : '', c.message)),
  );
}

export function verdictLabel(verdict?: string): string {
  return verdict ? verdict.replace('_', ' ') : 'not reviewed';
}

export function reviewView(cv: (CvVersion & { currentChecks: CheckReport }) | undefined): HTMLElement {
  if (!cv) return h('div', { class: 'doc' }, empty('No CV yet. Once your profile and a job listing are in, your coach will have one drafted.'));
  const root = h('div', { class: 'doc' });
  root.append(
    h('div', { class: 'doc-head' }, h('h2', {}, `Version ${cv.version}`), h('span', { class: `badge ${cv.status}` }, cv.status)),
    h(
      'p',
      { class: 'muted' },
      `Created ${formatTime(cv.createdAt)} from profile revision ${cv.profileRevision}`,
      cv.basedOnVersion ? ` · revised from v${cv.basedOnVersion}` : '',
      ` · writer run ${cv.writerRunId}`,
    ),
  );
  if (cv.changeSummary) root.append(h('p', {}, h('strong', {}, 'Changes: '), cv.changeSummary));
  if (cv.feedback) root.append(h('blockquote', {}, cv.feedback));

  const critique = cv.critiques.at(-1);
  root.append(h('h3', {}, 'Critic review'));
  if (!critique) root.append(empty('Not reviewed yet.'));
  else {
    root.append(
      h(
        'div',
        { class: 'score-row' },
        h('div', { class: `score verdict-${critique.verdict}` }, h('span', { class: 'score-num' }, String(critique.overallScore)), h('span', {}, '/100')),
        h(
          'div',
          {},
          h('div', { class: `verdict verdict-${critique.verdict}` }, verdictLabel(critique.verdict)),
          h('div', { class: 'subscores' }, ...Object.entries(critique.scores).map(([k, v]) => h('span', {}, `${k} ${v}/10`))),
          h('div', { class: 'muted' }, `by ${critique.model} for the ${critique.requestedBy}, ${formatTime(critique.at)}`),
        ),
      ),
      h('p', {}, critique.summary),
    );
    if (critique.issues.length)
      root.append(
        h('h4', {}, 'Issues'),
        h(
          'ul',
          { class: 'checks' },
          ...critique.issues.map((i) =>
            h('li', { class: `sev-${i.severity}` }, h('span', { class: 'sev' }, i.severity), ' ', i.location ? h('span', { class: 'muted' }, `${i.location}: `) : '', i.problem, i.suggestion ? h('div', { class: 'suggestion' }, `→ ${i.suggestion}`) : null),
          ),
        ),
      );
    if (critique.requirementCoverage.length)
      root.append(
        h('h4', {}, 'Requirement coverage'),
        h(
          'table',
          { class: 'coverage' },
          ...critique.requirementCoverage.map((r) => h('tr', {}, h('td', { class: `cov-${r.status}` }, r.status), h('td', {}, r.requirement, r.evidence ? h('div', { class: 'muted' }, r.evidence) : null))),
        ),
      );
    if (critique.strengths.length) root.append(h('h4', {}, 'Strengths'), h('ul', {}, ...critique.strengths.map((s) => h('li', {}, s))));
    if (critique.questionsForUser.length) root.append(h('h4', {}, 'Questions for you'), h('ul', {}, ...critique.questionsForUser.map((q) => h('li', {}, q))));
  }

  root.append(h('h3', {}, 'Automatic checks (against your current profile)'), checkList(cv.currentChecks.checks));
  const kc = cv.currentChecks.keywordCoverage;
  if (kc.matched.length || kc.missing.length)
    root.append(
      h('p', { class: 'chips' }, ...kc.matched.map((k) => h('span', { class: 'chip ok' }, k)), ...kc.missing.map((k) => h('span', { class: 'chip missing', title: 'Not in the CV' }, k))),
    );
  if (cv.exports.length) {
    root.append(h('h3', {}, cv.status === 'approved' ? 'Submission files' : 'Exports'));
    root.append(
      h(
        'ul',
        {},
        ...cv.exports.map((e) => {
          const link = (file: string, label: string) => h('a', { href: api.exportUrl(cv.jobId, file.split(/[\\/]/).pop()!) }, label);
          return h(
            'li',
            {},
            `${formatTime(e.at)} — `,
            e.pdf ? link(e.pdf, `PDF${e.pages ? ` (${e.pages} page${e.pages > 1 ? 's' : ''})` : ''}`) : 'no PDF',
            ' · ',
            link(e.html, 'HTML'),
            ' · ',
            link(e.markdown, 'Markdown'),
            h('div', { class: 'muted' }, e.pdf ?? e.html),
          );
        }),
      ),
    );
  }
  if (cv.critiques.length > 1)
    root.append(
      h('h3', {}, 'Earlier reviews of this version'),
      h('ul', {}, ...cv.critiques.slice(0, -1).map((c) => h('li', {}, `${formatTime(c.at)} — ${c.overallScore}/100, ${verdictLabel(c.verdict)} (${c.requestedBy})`))),
    );
  return root;
}

export function versionOptionLabel(v: VersionSummary): string {
  const parts = [`v${v.version}`];
  if (v.status === 'approved') parts.push('✓ approved');
  if (v.score !== undefined) parts.push(`${v.score}/100`);
  if (v.errors) parts.push(`${v.errors} error${v.errors > 1 ? 's' : ''}`);
  return parts.join(' · ');
}

export function auditView(records: AuditRecord[]): HTMLElement {
  if (!records.length) return h('div', { class: 'doc' }, empty('Nothing recorded yet.'));
  return h(
    'div',
    { class: 'doc' },
    h('h2', {}, 'Activity log'),
    h('p', { class: 'muted' }, 'Every change made by you or an agent, and every refused or failed action, newest first.'),
    h(
      'table',
      { class: 'audit' },
      h('tr', {}, h('th', {}, 'When'), h('th', {}, 'Who'), h('th', {}, 'What'), h('th', {}, 'Result')),
      ...records.map((r) =>
        h(
          'tr',
          { class: `outcome-${r.outcome}` },
          h('td', { class: 'muted' }, formatTime(r.at)),
          h('td', {}, h('span', { class: `agent agent-${r.actor}` }, r.actor)),
          h('td', {}, r.action.replace(/_/g, ' '), r.details ? h('details', {}, h('summary', {}, 'details'), h('pre', {}, JSON.stringify(r.details, null, 2))) : null),
          h('td', {}, r.outcome),
        ),
      ),
    ),
  );
}

type FieldSpec =
  | { key: keyof Style; label: string; type: 'range'; min: number; max: number; step: number; unit: string }
  | { key: keyof Style; label: string; type: 'select'; options: Array<[string, string]> }
  | { key: keyof Style; label: string; type: 'color' };

export function styleFields(config: AppConfigView): FieldSpec[] {
  const fonts = config.fonts.map((f) => [f.id, `${f.label} (${f.kind})`] as [string, string]);
  return [
    { key: 'fontFamily', label: 'Typeface', type: 'select', options: fonts },
    { key: 'headingFontFamily', label: 'Heading typeface', type: 'select', options: [['same', 'Same as body'], ...fonts] },
    { key: 'baseFontSize', label: 'Text size', type: 'range', min: 8, max: 13, step: 0.5, unit: 'pt' },
    { key: 'nameFontSize', label: 'Name size', type: 'range', min: 14, max: 34, step: 1, unit: 'pt' },
    { key: 'lineHeight', label: 'Line spacing', type: 'range', min: 1, max: 1.8, step: 0.05, unit: '×' },
    { key: 'marginVerticalMm', label: 'Top/bottom margin', type: 'range', min: 6, max: 30, step: 1, unit: 'mm' },
    { key: 'marginHorizontalMm', label: 'Side margin', type: 'range', min: 6, max: 30, step: 1, unit: 'mm' },
    { key: 'sectionSpacingPt', label: 'Space between sections', type: 'range', min: 0, max: 24, step: 1, unit: 'pt' },
    { key: 'itemSpacingPt', label: 'Space between entries', type: 'range', min: 0, max: 16, step: 0.5, unit: 'pt' },
    { key: 'bulletSpacingPt', label: 'Space between bullets', type: 'range', min: 0, max: 6, step: 0.5, unit: 'pt' },
    { key: 'pageSize', label: 'Paper', type: 'select', options: [['A4', 'A4'], ['Letter', 'US Letter']] },
    { key: 'headerAlign', label: 'Header', type: 'select', options: [['left', 'Left-aligned'], ['center', 'Centred']] },
    { key: 'sectionTitleStyle', label: 'Section titles', type: 'select', options: [['caps-rule', 'Capitals with rule'], ['caps', 'Capitals'], ['plain', 'Plain']] },
    { key: 'bulletChar', label: 'Bullet', type: 'select', options: [['•', '• dot'], ['–', '– dash'], ['▪', '▪ square'], ['›', '› chevron']] },
    { key: 'accentColor', label: 'Accent colour', type: 'color' },
  ];
}

/** Builds the style controls; calls onChange with a partial style as the user edits. */
export function buildStyleForm(
  form: HTMLElement,
  config: AppConfigView,
  style: Style,
  onChange: (patch: Partial<Style> & { preset?: string }) => void,
): void {
  form.replaceChildren();
  form.append(
    h('h3', {}, 'Presets'),
    h('div', { class: 'presets' }, ...Object.keys(config.presets).map((p) => h('button', { type: 'button', class: 'btn subtle', onclick: () => onChange({ preset: p }) }, p))),
  );
  for (const f of styleFields(config)) {
    const current = String(style[f.key]);
    let input: HTMLInputElement | HTMLSelectElement;
    let out: HTMLElement | null = null;
    if (f.type === 'select') {
      input = h('select', { name: f.key }, ...f.options.map(([v, label]) => h('option', { value: v, selected: v === current }, label)));
      if (!f.options.some(([v]) => v === current)) input.prepend(h('option', { value: current, selected: true }, current));
    } else if (f.type === 'color') {
      input = h('input', { type: 'color', name: f.key, value: current });
    } else {
      input = h('input', { type: 'range', name: f.key, min: f.min, max: f.max, step: f.step, value: current });
      out = h('output', {}, `${current}${f.unit}`);
      const unit = f.unit;
      input.addEventListener('input', () => (out!.textContent = `${input.value}${unit}`));
    }
    const key = f.key;
    input.addEventListener(f.type === 'range' ? 'change' : 'input', () => {
      const value = f.type === 'range' ? Number(input.value) : input.value;
      onChange({ [key]: value } as Partial<Style>);
    });
    form.append(h('label', { class: 'field' }, h('span', {}, f.label, out ? ' ' : '', out), input));
  }
  form.append(h('button', { type: 'button', class: 'btn subtle', onclick: () => onChange({ ...config.defaultStyle }) }, 'Reset to default'));
}
