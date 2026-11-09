---
name: ats-cv-writing
description: Playbook for writing a tailored, ATS-friendly CV in semantic HTML with a clean print stylesheet, including bullet formulas, keyword mapping and page-fit rules. Use when drafting a new CV, restructuring an existing one, or fitting a CV to a page limit.
---

# ATS-friendly CV writing

## 1. Map the job before writing
1. From `readJob`, list the top 8–12 requirements and keywords (hard skills, tools, domain terms, seniority signals).
2. For each, find evidence in the profile (`readProfile` with `query` is fastest). Mark: **strong** evidence, **weak** evidence, **none**.
3. Order sections and roles so the strongest evidence for the top requirements appears in the top third of page 1.
4. Requirements with no evidence are *not* written into the CV — list them in your report as questions for the user.

## 2. Structure (HTML fragment)
Start from `assets/cv-skeleton.html` (load it with `loadSkill {name: "ats-cv-writing", file: "assets/cv-skeleton.html"}`). It matches the default stylesheet classes: `header`, `.headline`, `.contact`, `section > h2`, `.role`, `.role-head`, `.meta`, `.org`, `.skills`.
- Standard headings ATS parsers recognise: Summary, Experience, Skills, Education, Projects, Certifications.
- One column, real text, no tables for layout, no icons-as-text, dates as `Mon YYYY – Mon YYYY`.
- Contact details as plain text inside `header`; links as visible text (e.g. `linkedin.com/in/name`).

## 3. Writing rules
- **Summary**: 2–3 lines — role identity + years + 2 headline strengths aligned to the job + what they want next. No "I", no clichés ("hard-working team player").
- **Bullets**: `Action verb + what you did + measurable result + (how / tools)`. Example: "Cut checkout latency 38% by moving pricing to an edge cache (Redis, Go)".
- 3–5 bullets for recent/relevant roles, 1–2 for older ones; roles older than ~10–15 years can be one line.
- Mirror the job's exact keyword spelling where truthful ("Kubernetes", not "k8s").
- Consistent tense: past for previous roles, present for the current role.
- British vs American spelling follows `preferences.language`.

## 4. Fit the page limit
- `readCV` returns `pages` (rendered PDF page count) and `words`. Target ≈ 450–600 words per A4/Letter page at 10–11pt.
- Over the limit? In order: trim older roles → cut weakest bullets → tighten wording → reduce spacing in CSS (`section` margins, `line-height` ≥ 1.3) → font-size no smaller than 9.5pt.
- Under by a lot? Add evidence for top requirements before adding anything else.
- Avoid a final page that is mostly empty: aim for ≥ 60% filled.

## 5. CSS conventions
- Keep the user-visible stylesheet tidy: a header comment, variables in `:root`, grouped rules.
- Print-safe: `@page { margin: … }`, `break-inside: avoid` on `.role`, no fixed heights, no viewport units.
- Don't set `@page { size }` — the page size comes from preferences.

## 6. Final check before reporting
- Every fact traceable to the profile; no placeholders left.
- Name, contact and dates correct; no orphan headings at page bottoms.
- Run `callCritic` once the draft is complete; apply must-fix items that the profile supports.
