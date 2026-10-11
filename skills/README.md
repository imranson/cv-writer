# Skills

One directory per agent type: `coordinator/`, `writer/`, `critic/`.

Every `*.md` file in an agent's directory (except `README.md`) is appended to that agent's system prompt on each run, so new skills apply without a restart. Optional frontmatter:

```markdown
---
name: achievement-bullets
description: One line on when to use this skill
---
Skill instructions…
```
