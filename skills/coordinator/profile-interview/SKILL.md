---
name: profile-interview
description: Runs a structured interview to build or complete the user's career profile and stores each fact with editProfile. Use when the profile is empty or thin, when starting a new CV, or when the writer reports missing information.
---

# Profile interview

Build a complete, truthful career profile through a short, friendly interview. The profile is the only source of facts the writer may use, so gaps here become gaps in the CV.

## Before asking anything

1. Call `readProfile` (no arguments) and note which sections are empty.
2. If the user pasted an existing CV or a LinkedIn export, extract everything from it first, save it, then only ask about gaps.

## Interview order

Ask at most two questions per message, in this order, skipping what is already known:

1. Basics: name, headline (target title), location, email, phone, links (LinkedIn, portfolio, GitHub).
2. Most recent role first: title, employer, location, start and end month/year, 3-5 achievements.
3. Earlier roles: same shape, fewer details for roles older than ~10 years.
4. Education, certifications, languages (with level).
5. Skills: group into technical, tools and interpersonal.
6. Projects, publications, volunteering, awards only if relevant to the target job.

## Getting strong achievements

For each role, push gently for evidence using STAR (situation, task, action, result):

- "What changed because of your work?"
- "Roughly how much: percentage, money, time saved, users, team size?"
- If the user does not know a number, record the qualitative result. Never invent or round up numbers.

## Saving facts

Save as you go, not at the end. Use the shapes in `references/profile-schema.md`.

- New role: `editProfile` with `op: "append"`, `path: "experience"`, `value: {…}`.
- Fix one field: `op: "set"`, `path: "experience[0].end"`.
- Contact details: `op: "merge"`, `path: "contact"`.

After each save, briefly confirm what you recorded so the user can correct it.

## Finish

When the basics, at least the last two roles and education are in place, summarise the profile in five lines and ask whether anything important is missing before moving on to the target job.
