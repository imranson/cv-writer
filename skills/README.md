# Agent skills

Skills follow Anthropic's Agent Skills convention, grouped by the agent allowed to use them:

```
skills/<agent>/<skill-name>/
├── SKILL.md          # required: YAML frontmatter (name, description) + Markdown instructions
└── references/       # optional: files the skill tells the agent to load on demand
```

- `name`: 1–64 chars, lowercase letters, digits and hyphens; must match the folder name.
- `description`: what the skill does **and when to use it** (≤ 1024 chars). This is the only part
  placed in the agent's system prompt (progressive disclosure).
- The body is loaded with the `loadSkill` tool (`{ "name": "<skill-name>" }`); bundled files with
  `{ "name": "<skill-name>", "file": "references/…" }`.

Agents only see their own folder: `coordinator/`, `writer/`, `critic/`. Add a folder with a valid
`SKILL.md` and restart the server to add a skill; invalid skills are skipped with a warning in the logs.
