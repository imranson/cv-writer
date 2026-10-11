import type { AgentName } from './types.ts';

const LABELS: Record<string, [running: string, done: string]> = {
  read_profile: ['Reading profile', 'Read profile'],
  update_profile: ['Saving profile', 'Saved profile'],
  edit_profile: ['Updating profile', 'Updated profile'],
  list_jobs: ['Listing jobs', 'Listed jobs'],
  read_job: ['Reading job listing', 'Read job listing'],
  save_job: ['Saving job listing', 'Saved job listing'],
  update_job: ['Updating job listing', 'Updated job listing'],
  set_active_job: ['Switching job', 'Switched job'],
  write_cv: ['CV Writer is working', 'CV Writer finished'],
  critique_cv: ['CV Critic is reviewing', 'CV Critic finished'],
  read_cv: ['Reading CV', 'Read CV'],
  edit_cv: ['Editing CV', 'Edited CV'],
  read_style: ['Reading style', 'Read style'],
  set_style: ['Updating style', 'Updated style'],
  export_pdf: ['Rendering PDF', 'Rendered PDF'],
  check_pages: ['Counting pages', 'Counted pages'],
  fetch_url: ['Fetching page', 'Fetched page'],
  list_skills: ['Listing skills', 'Listed skills'],
  read_skill: ['Reading skill', 'Read skill'],
  request_critique: ['Asking the critic', 'Critic replied'],
  submit_critique: ['Submitting critique', 'Submitted critique'],
};

const ICONS: Record<string, string> = {
  write_cv: '✍️',
  edit_cv: '✍️',
  critique_cv: '🔎',
  request_critique: '🔎',
  submit_critique: '📋',
  update_profile: '👤',
  edit_profile: '👤',
  read_profile: '👤',
  save_job: '📌',
  update_job: '📌',
  read_job: '📌',
  set_active_job: '📌',
  set_style: '🎨',
  read_style: '🎨',
  export_pdf: '📄',
  fetch_url: '🌐',
  read_skill: '📚',
  list_skills: '📚',
};

const AGENT_NAMES: Record<AgentName, string> = { coordinator: 'Coach', writer: 'Writer', critic: 'Critic' };

export function agentLabel(agent: AgentName): string {
  return AGENT_NAMES[agent];
}

export function toolIcon(name: string): string {
  return ICONS[name] ?? '🔧';
}

/** Human-readable label for a tool call, e.g. "Saved job listing" or "Writing CV". */
export function toolLabel(name: string, args: Record<string, unknown> = {}, done = false): string {
  const pair = LABELS[name];
  let label = pair ? pair[done ? 1 : 0] : name.replace(/_/g, ' ');
  if (name === 'read_skill' && typeof args.id === 'string') label += `: ${args.id}`;
  if (name === 'save_job' && typeof args.title === 'string') label += `: ${args.title}${typeof args.company === 'string' ? ` — ${args.company}` : ''}`;
  if (name === 'fetch_url' && typeof args.url === 'string') label += `: ${args.url}`;
  if (name === 'set_style' && typeof args.preset === 'string') label += ` (${args.preset})`;
  return label;
}

/** Extracts "Score: 78/100 — verdict: needs work" from a critique tool result for the chip. */
export function resultHighlight(name: string, output: string): string | null {
  if (name === 'critique_cv' || name === 'request_critique') {
    const m = output.match(/Score:\s*(\d+)\/100\s*—\s*verdict:\s*([a-z ]+)/i);
    return m ? `${m[1]}/100 · ${m[2]?.trim()}` : null;
  }
  if (name === 'write_cv') {
    const m = output.match(/CV saved \((\d+) words\)/);
    return m ? `${m[1]} words` : null;
  }
  if (name === 'export_pdf') {
    const m = output.match(/PDF rendered: (\d+) page/);
    return m ? `${m[1]} page${m[1] === '1' ? '' : 's'}` : null;
  }
  return null;
}
