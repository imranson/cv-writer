# Skills

One directory per agent type: `coordinator/`, `writer/`, `critic/`. Inside it, one directory per skill:

```
<agent>/skill-name/
├── SKILL.md          # Required: metadata + instructions
├── scripts/          # Optional: executable code
├── references/       # Optional: documentation
├── assets/           # Optional: templates, resources
└── ...               # Any additional files or directories
```

Skills use progressive disclosure. The system prompt lists only each skill's `name` and `description`; the agent calls `loadSkill` with the name to read the SKILL.md body, which also lists the bundled files, and calls it again with `file` (a path relative to the skill, e.g. `references/guide.md`) to read one. Agents can read bundled text files but cannot run scripts. Files are re-read on every run and every `loadSkill` call, so edits apply without a restart.

SKILL.md frontmatter. The description is all the agent sees before loading, so say what the skill covers and when to use it. `name` should match the directory name (it defaults to it):

```markdown
---
name: achievement-bullets
description: What it covers. Load before <task>
---
Skill instructions… Point to bundled files by relative path, e.g. "for examples see references/examples.md".
```
