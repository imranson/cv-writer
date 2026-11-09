/** Starting shapes for user-owned JSON documents. Agents and users may add any extra keys. */

export function defaultProfile(name = '', email = ''): Record<string, unknown> {
  return {
    basics: { name, email, phone: '', location: '', headline: '', links: [] },
    summary: '',
    experience: [],
    education: [],
    skills: [],
    projects: [],
    certifications: [],
    languages: [],
    achievements: [],
    interests: [],
    notes: '',
  };
}

export function defaultJob(): Record<string, unknown> {
  return {
    title: '',
    company: '',
    location: '',
    url: '',
    description: '',
    requirements: [],
    keywords: [],
    notes: '',
    status: 'draft',
  };
}

export function defaultPreferences(): Record<string, unknown> {
  return {
    pageSize: 'A4',
    maxPages: 2,
    tone: 'professional',
    language: 'en-GB',
    sections: ['summary', 'experience', 'skills', 'education', 'projects'],
    emphasis: [],
    avoid: [],
    notes: '',
  };
}

export const DEFAULT_CSS = `/* CV stylesheet — edited by you or the writer agent. Applied to the CV HTML for preview and PDF. */
@page { margin: 14mm 15mm; }
:root { --ink: #1d2433; --muted: #5b6475; --accent: #1f5f8b; --rule: #d9dee7; }
* { box-sizing: border-box; }
body { font-family: "Helvetica Neue", Arial, sans-serif; color: var(--ink); font-size: 10.5pt; line-height: 1.42; margin: 0; }
header { border-bottom: 2px solid var(--accent); padding-bottom: 6pt; margin-bottom: 10pt; }
h1 { font-size: 22pt; margin: 0; letter-spacing: -0.3pt; }
.headline { color: var(--accent); font-size: 11.5pt; margin: 2pt 0 4pt; }
.contact { color: var(--muted); font-size: 9.5pt; display: flex; flex-wrap: wrap; gap: 4pt 12pt; padding: 0; margin: 0; list-style: none; }
.contact a { color: inherit; text-decoration: none; }
section { margin-bottom: 10pt; }
h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 1pt; color: var(--accent); border-bottom: 1px solid var(--rule); padding-bottom: 2pt; margin: 0 0 6pt; }
h3 { font-size: 10.5pt; margin: 0; }
.role { margin-bottom: 7pt; break-inside: avoid; }
.role-head { display: flex; justify-content: space-between; gap: 8pt; }
.meta { color: var(--muted); font-size: 9.5pt; white-space: nowrap; }
.org { color: var(--muted); font-style: italic; }
ul { margin: 3pt 0 0 0; padding-left: 14pt; }
li { margin-bottom: 1.5pt; }
.skills { display: flex; flex-wrap: wrap; gap: 4pt; padding: 0; list-style: none; }
.skills li { border: 1px solid var(--rule); border-radius: 3pt; padding: 1pt 5pt; font-size: 9.5pt; }
`;
