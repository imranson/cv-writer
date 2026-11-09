# CV Writer

Experimental CV writer from elicitation to CV creation: one **Coordinator** agent talks to the user from first message to finished PDF, delegating to a **Writer** and a **Critic** subagent. TypeScript · Hono · Ollama cloud models · PostgreSQL (PGlite locally) · Playwright PDF · Docker/Railway.

## Quick start (local, no Docker)

```bash
npm install
npx playwright install chromium     # once, for PDF rendering
ollama signin                       # local daemon proxies *:cloud models — or set OLLAMA_API_KEY
npm run build && npm start          # http://localhost:3000
```

Without `DATABASE_URL` an embedded PGlite database is stored in `./data/db`. `npm run dev` rebuilds the client and watches the server.

## Deploy to Railway

1. Create a project from this repo — Railway picks up `railway.json` and builds the `Dockerfile` (Playwright base image, Chromium included).
2. Add a **PostgreSQL** service and reference its `DATABASE_URL` in the app service variables.
3. Set `OLLAMA_API_KEY` (ollama.com → Settings → Keys) and `NODE_ENV=production`. Optional: `OLLAMA_MODEL` / `COORDINATOR_MODEL` / `WRITER_MODEL` / `CRITIC_MODEL`.
4. Healthcheck: `/api/health`. Migrations run automatically on boot.

See `.env.example` for every setting. In-flight chat turns live in process memory, so run a single replica.

## How it works

| Agent | Talks to user | Tools |
|---|---|---|
| Coordinator | ✅ only one | readProfile, editProfile, readJob, editJob, readCV, readCSS, readPreferences, editPreferences, callWriter, callCritic, loadSkill |
| Writer | ❌ (called by coordinator) | readCV, editCV, readCSS, editCSS, readProfile, readJob, readPreferences, loadSkill, callCritic |
| Critic | ❌ (called by writer or coordinator) | readCV, readJob, readPreferences, loadSkill |

All three also get `evalMath` (safe parser, no `eval`), `webSearch` (Ollama web search API with a key, DuckDuckGo otherwise) and `webFetch` (SSRF-guarded). Every LLM call carries a **System information** block with the current date/time (user's time zone) and a context-window indicator (estimated tokens / model window from `/api/show`, plus the model-reported prompt size of the previous call). Old tool output is truncated automatically when a transcript nears the window.

- `readProfile` **reads or searches** depending on arguments (none → all, `path` → one field, `query` → keyword search). `editProfile` **writes or updates** (`profile` → replace, `patch` → JSON Merge Patch, `path`+`value` → set, `deletePath` → remove). Jobs and preferences use the same semantics; CV and CSS take a full write or exact find/replace edits.
- **Data model per user**: 1 profile (JSON) → N jobs (JSON) → 1 CV (HTML) per job → 1 preferences (JSON) + 1 stylesheet (raw CSS, editable in the UI) per CV. Chat sessions (JSON, including each turn's full activity tree) are independent.
- **Skills** follow Anthropic's Agent Skills layout — `skills/<agent>/<skill-name>/SKILL.md` with `name`/`description` frontmatter plus bundled files. Agents see names + descriptions and load bodies/files on demand with `loadSkill`. Samples: `cv-intake-interview` (coordinator), `ats-cv-writing` (writer), `cv-review-rubric` (critic).
- **Activity view**: every agent run, LLM call, streamed thinking, tool call with full arguments/results, nested subagents, durations, model-reported token usage and per-agent context meters — live over SSE and persisted per turn. Turns survive a page reload (the UI re-attaches) or can be stopped.
- **Accounts**: register/sign in; several accounts can be signed in at once in one browser with an account switcher (httpOnly cookies, scrypt hashes, hashed session tokens, login rate limiting, CSRF header check). API clients can use `Authorization: Bearer`.
- **PDF**: Playwright/Chromium with JavaScript disabled and network limited to Google Fonts; page size from preferences; the rendered page count is fed back to the writer and critic via `readCV`.

## Tests

```bash
npm test                              # 180+ unit + integration tests (PGlite in-memory, real Chromium for PDF)
LIVE_OLLAMA=1 npx vitest run tests/live   # optional smoke test against a real Ollama model
npm run typecheck
```

Integration tests drive the real HTTP app, database, tools and agent loop with a scripted LLM (coordinator → writer → critic chains, permissions, aborts, SSE streaming, re-attach, account isolation).
