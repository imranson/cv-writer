---
name: ats-cv-writing
description: Writing rules and an HTML structure for tailored, ATS-friendly CVs that also read well to humans. Use before writing a new CV or substantially revising one, and when fixing layout, length or keyword coverage.
---

# ATS-friendly CV writing

## 1. Plan before writing
1. From the job (`readJob`): list the 8–12 most important requirements and the exact terms the advert uses.
2. From the profile (`readProfile`): map each requirement to concrete evidence. Requirements with no evidence are **gaps** — report them; never fill them with invented content.
3. From preferences (`readPreferences`): language/spelling (en-GB "optimise" vs en-US "optimize"), `maxPages`, `tone`, `sectionOrder`, `emphasise`, `exclude`.

## 2. Structure
Use the skeleton in `references/cv-template.html` (load it with `loadSkill` + `file`). It uses the class names the default stylesheet expects. Rules:
- One column, real text, standard section headings (Summary/Profile, Experience, Skills, Education, Certifications, Projects).
- Reverse-chronological experience. Dates as "Mar 2021 – Present" consistently.
- Contact details in the header as plain text/links. No photo unless `includePhoto` is true and the region expects it.
- No tables for layout, no text in images, no icons carrying meaning.

## 3. Content rules
- **Summary**: 2–3 lines, target title + years of relevant experience (use `evalMath`) + 2 strongest proofs aligned to the job.
- **Bullets**: start with a strong past-tense verb (present tense for the current role is fine); one line ideally, two at most; **action + scope + result**. Lead with the most job-relevant bullet. 3–5 bullets for recent roles, 1–2 for older ones; roles older than ~12 years can be summarised.
- Mirror the advert's terminology **only where the profile supports it** (e.g. "stakeholder management" if the user evidenced it).
- Skills section: grouped, relevant first, no rating bars. Do not list skills the profile does not support.
- Cut: "responsible for", "duties included", references available on request, full street address, date of birth, marital status.

## 4. Length and layout
- `editCV` and `editCSS` return the rendered page count. If it exceeds `maxPages`: first cut weak/old content, then tighten CSS (font-size no lower than 9.5pt, margins no lower than 12mm, reduce spacing).
- Avoid a final page that is only a few lines: trim or loosen spacing.
- Paper size comes from preferences; keep `@page` margins in the CSS.

## 5. Quality checks before calling the Critic
- Every claim traceable to the profile.
- Consistent tense, date format, punctuation (no full stops at bullet ends, or always — be consistent).
- Spelling variant matches `language`.
- Job title and company of the target are never claimed as the user's.
