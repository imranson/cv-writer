---
name: ats-cv-html
description: Conventions for writing an ATS-friendly, print-ready CV as an HTML fragment plus CSS, including the section markup, class names and page-fitting rules. Use when drafting a CV from scratch, restructuring one, or changing its layout or stylesheet.
---

# ATS-friendly CV in HTML + CSS

The CV body is an HTML fragment rendered inside `<body>`; the stylesheet is separate (`editCSS`). Playwright prints it to PDF with `preferCSSPageSize`, so `@page` in the CSS controls paper size and margins.

## Markup rules

- One `<header class="cv-header">` with `<h1>` name, `<p class="headline">`, and `<p class="contact">` (separate items with ` · `).
- Each section is `<section id="…"><h2>Standard heading</h2>…</section>`. Use standard headings ATS parsers recognise: Summary, Experience, Skills, Education, Certifications, Projects, Languages.
- Each role is `<article class="role">` containing `<h3>Title — Company</h3>`, `<p class="role-meta"><span>Location</span><span>Mar 2021 – Present</span></p>`, then a `<ul>` of achievements.
- Skills as `<ul class="skills">` of short items; no skill bars, ratings or icons.
- No tables for layout, no images, no text in headers/footers, no multi-column layouts that reorder reading order.
- Plain text links: show the URL text (e.g. `linkedin.com/in/alex`), not "click here".

A complete skeleton is in `references/template.html` (load it with `loadSkill` and `file: "references/template.html"`).

## Writing rules

- Lead every bullet with a strong verb, then the result with its number if the profile has one: "Cut pipeline runtime 86% (6h → 50m) by …".
- 3-5 bullets for recent roles, 1-2 for older ones; drop roles older than ~15 years unless relevant.
- Mirror the job posting's exact terms where the profile supports them (e.g. "stakeholder management", "Kubernetes").
- Keep tense consistent: past for previous roles, present for the current one.
- Use the preference `language` for spelling (en-GB: "optimised", en-US: "optimized").

## Fitting the page budget

`maxPages` is a ceiling, not a target. If the true content is short, the CV is short: never pad it with responsibilities, metrics or tools that are not in the profile. Improve layout and wording instead, and list missing information as open questions.

With the default CSS, one A4 page holds ~450-550 words. If over `maxPages`:

1. Cut older roles' bullets, then weak bullets everywhere.
2. Merge small sections (e.g. Languages into Skills).
3. Only then tighten CSS: body font no smaller than 9.5pt, margins no smaller than 10mm.

Use `evalMath` for word-count budgets if helpful.

## CSS conventions

- Keep `@page { size: A4; margin: … }` aligned with the `pageSize` preference (`size: Letter` for US).
- Add `break-inside: avoid` to `.role` so roles do not split across pages.
- Prefer system fonts or Google Fonts via `@import url("https://fonts.googleapis.com/…")` at the top of the CSS.
