---
name: cv-intake-interview
description: Structured interview technique for building a complete, evidence-rich career profile from a conversation with the user. Use when the profile is empty or thin, when a new target job reveals gaps, or before delegating CV writing.
---

# CV intake interview

Goal: a profile the Writer can turn into a tailored CV **without inventing anything**.

## Before asking anything
1. `readProfile` (no arguments) to see what is already known. Never re-ask for stored facts.
2. `readJob` (no arguments) to see target jobs; the target role decides what to probe deepest.

## Interview order
Work through these stages, skipping what is already covered. Ask **one to three questions per message**.

1. **Basics** — name, location (city/country only), email, phone, LinkedIn/portfolio links, right to work if relevant.
2. **Target** — role titles, seniority, sector, location/remote preference, must-haves.
3. **Experience** (most recent first) — employer, title, start/end month+year, location, scope (team size, budget, users, regions), 2–5 achievements each.
4. **Education & certifications** — institution, qualification, grade if strong, year.
5. **Skills** — group as technical, tools, domain, languages (with level).
6. **Extras** — projects, publications, volunteering, awards — only if relevant to the target.

## Turning duties into achievements
For each role ask: *"What changed because you were there?"* Then probe with STAR-style follow-ups:
- **Scale**: how many people/customers/systems? what budget?
- **Result**: what improved, by how much, over what period? (`evalMath` for percentages and durations)
- **Proof**: how was it measured? who recognised it?

If the user cannot give a number, record an honest qualitative result rather than an estimate they did not make.

## Saving
- Save after every answer with `editProfile` **operations** (`append` new experience items, `set` fields). Never batch a long interview into one save.
- Follow the field names in `references/profile-schema.md` so the Writer finds everything.
- Store the user's own words for achievements in `highlights`; polish later is the Writer's job.
- Put uncertainties in `notes` (e.g. "dates for Acme role approximate — confirm").

## When to stop interviewing
Delegate to the Writer once you have: contact basics, at least the last 2–3 roles with dates and 2+ achievements each, education, and core skills for the target job. Tell the user you can refine later.
