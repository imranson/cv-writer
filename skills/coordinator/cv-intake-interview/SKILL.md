---
name: cv-intake-interview
description: Structured interview technique for building a user's career profile from scratch or filling gaps before a CV is written. Use when the profile is empty or thin, when a target job needs evidence the profile lacks, or when the user says they don't know what to put on their CV.
---

# CV intake interview

Goal: turn a conversation into a complete, evidence-rich profile JSON — without overwhelming the user.

## Before asking anything
1. `readProfile` (no arguments) and `readJob` (list). Note which sections are empty.
2. If a target job exists, read it and list the 3–5 requirements the profile cannot yet evidence. Those gaps drive the interview order.

## Interview loop
Work section by section in this order, skipping anything already known:
1. **Basics** — name, email, phone, location, LinkedIn/portfolio links, one-line headline.
2. **Experience** (most recent first) — employer, title, dates (month/year), location, then *achievements*.
3. **Education** — institution, qualification, dates, notable results.
4. **Skills** — group as technical / tools / domain / languages.
5. **Extras** — projects, certifications, awards, volunteering, publications.

Rules for each turn:
- Ask **at most 3 questions**, the most valuable first.
- Offer an example answer so the user knows the level of detail you want.
- After every answer, **save immediately** with `editProfile` — `patch` for new sections, `path`+`value` (e.g. `experience[]` to append) for single items. Confirm briefly what you saved.

## Digging for achievements
For each role ask for 2–4 achievements using STAR prompts, then turn them into outcomes:
- "What were you responsible for, and what changed because of you?"
- "Can you put a number on it — %, £/$, time saved, users, team size, rankings?"
- "What would your manager say was your biggest win there?"
If the user can't quantify, record scope instead (team of 6, 3 markets, 40 clients). Never invent numbers. Use `evalMath` for any calculation (e.g. tenure, percentage change).

See `references/question-bank.md` for role-specific prompts (engineering, sales, design, operations, graduates, career changers).

## Profile JSON conventions
- `experience[]` item: `{ "company", "title", "location", "start": "YYYY-MM", "end": "YYYY-MM" | "present", "summary", "highlights": [string], "skills": [string] }`
- `education[]` item: `{ "institution", "qualification", "field", "start", "end", "grade", "highlights": [] }`
- `skills[]` item: `{ "category", "items": [string] }`
- Keep the user's own wording in `notes` when it carries nuance you may need later.

## Done when
Basics complete, every role in the last ~10 years has dates and 2+ highlights, and each key job requirement maps to evidence (or the user has confirmed there is none). Then summarise the profile in 3–5 bullets and move on to preferences and writing.
