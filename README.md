# CV Writer

Experimental CV writer from elicitation to CV creation. A single **coordinator** agent talks to the user from start to finish and delegates to a **writer** and a **critic** subagent. Models run on Ollama (cloud models such as `kimi-k2.6:cloud`), the app is TypeScript end to end, and PDFs are rendered with Playwright.

## Running

```bash
cp .env.example .env      # set OLLAMA_API_KEY (and optionally OLLAMA_THINK=false for faster turns)
npm start                 # builds the frontend, serves http://localhost:4817
```

Register an account, then chat. The right-hand panel shows the selected job's CV (HTML preview or Playwright PDF, with download), its raw CSS (editable), its preferences, the job itself, your profile, and a full activity log.

## Agents and tools

| Agent | Talks to user | Tools |
|---|---|---|
| Coordinator | yes (only one) | readProfile, editProfile, readJob, editJob, readCV, readPreferences, editPreferences, readCSS, callWriter, callCritic, loadSkill |
| Writer | no (called by coordinator) | readCV, editCV, readPreferences, readCSS, editCSS, readProfile, loadSkill, callCritic |
| Critic | no (called by coordinator or writer) | readCV, readPreferences, readJob, loadSkill |

All three also have `evalMath`, `webSearch` and `webFetch`. Every agent's system prompt includes the current date and time and a context window indicator (`used / window tokens`). The UI streams all tool calls, results, subagent runs and per-agent context usage.

- `readProfile`: no args returns the whole profile; `path` reads one part; `query` searches.
- `editProfile`: `profile` writes the whole profile; `path` + `op` (`set`, `merge`, `append`, `remove`) updates one part.
- `editJob`: no `jobId` creates a job; `jobId` + `job` updates it; `jobId` + `delete` removes it along with its CV, preferences and CSS.
- `readPreferences` / `editPreferences`: read or update one CV's preferences; `editPreferences` merges only the fields given (arrays are replaced whole).
- `callWriter` passes the job posting and saved CV preferences to the writer automatically.

## Data model

One directory per data type under `DATA_DIR`, partitioned by user:

```
data/
  users/<userId>.json                 account (scrypt password hash)
  profiles/<userId>.json              1 profile per user
  jobs/<userId>/<jobId>.json          N jobs per user
  cvs/<userId>/<jobId>.html           1 CV per job
  preferences/<userId>/<jobId>.json   1 preferences file per CV
  styles/<userId>/<jobId>.css         1 stylesheet per CV
  sessions/<userId>/<sessionId>.json  chat sessions (independent of jobs)
```

## Skills

`skills/<agent>/<skill-name>/SKILL.md` follows Anthropic's Agent Skills convention: YAML frontmatter with `name` and `description`, Markdown instructions, and optional bundled files. Agents see the name and description of each skill in their system prompt and load the full skill (or a bundled file) with `loadSkill`.

- `coordinator/profile-interview`: structured profile interview (+ `references/profile-schema.md`)
- `writer/ats-cv-html`: ATS-friendly HTML/CSS conventions (+ `references/template.html`)
- `critic/cv-review-rubric`: weighted scoring rubric

## Tests

```bash
npm test                  # unit + integration + browser e2e (scripted model, no network)
npm run test:unit
npm run test:integration  # HTTP API, SSE chat flow, Playwright PDF
npm run test:e2e          # drives the real UI in headless Chromium
npm run test:live         # optional: real Ollama model from .env
npm run typecheck
```
