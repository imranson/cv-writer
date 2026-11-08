# CV Writer

End-to-end CV writing web app. You talk to one agent, the **Coordinator**, from start to finish. It interviews you, saves your career profile, records the jobs you're targeting, and hands the writing and reviewing to two subagents, a **Writer** and a **Critic**. Each CV renders live in the browser and downloads as a PDF.

**Stack:** TypeScript · Hono (Node 22) · Ollama cloud models · PostgreSQL (`pg`, with embedded PGlite for local dev and tests) · Playwright (Chromium PDF rendering) · Vitest · a vanilla TypeScript client bundled with esbuild.

## Features

- **Multi-user auth.** Email and password with scrypt hashes and httpOnly session cookies, of which only the hashes are stored. You can be signed in to up to 5 accounts in one browser at once and switch between them, Google-style.
- **One coordinator talks to the user.** The Writer and Critic report only to the agent that called them.
- **Agent activity panel.** It shows every model step (reasoning included), every tool call with its arguments and result, nested subagent runs, token usage and a context gauge for each agent. The chat header also shows the coordinator's context. Everything streams live over SSE and is saved with the chat.
- **System info for every agent.** Each model call includes the current date and time (in the user's time zone) and a context-window indicator: tokens used out of the window, and whether that count is estimated or reported by the model. The window size is detected from Ollama's `/api/show`.
- **Workspace inspector.** Tabs for the profile JSON, the job JSON, a live CV preview (sandboxed iframe) with PDF download, the **raw CSS**, and the per-CV preferences JSON. All of them can be edited by hand.
- **Skills.** Anthropic Agent Skills convention, with a separate skill set per agent (see [`skills/`](skills/README.md)).

## Agents and tools

| Agent | Tools (all three also get `evalMath`, `webSearch`, `webFetch`) | Skill |
|---|---|---|
| Coordinator | `readProfile` (read or search), `editProfile` (write or update), `readJob`, `editJob`, `readCV`, `readCSS`, `readPreferences`, `editPreferences`, `callWriter`, `callCritic`, `loadSkill` | `cv-intake-interview` |
| Writer | `readCV`, `editCV`, `readCSS`, `editCSS`, `readProfile`, `readJob`, `readPreferences`, `loadSkill`, `callCritic` | `ats-cv-writing` |
| Critic | `readCV`, `readJob`, `readPreferences`, `loadSkill` | `cv-review-rubric` |

How the tools behave:

- **`read*` tools** read the whole document, or a specific `path`, or search it with a `query`.
- **`edit*` tools** replace the whole document (`profile` / `job` / `html` / `css` / `preferences`) or make targeted updates: JSON `operations` (`set`/`merge`/`append`/`remove` by path) or exact find/replace `edits` for HTML and CSS.
- **`editCV` and `editCSS`** return the rendered page count, so the Writer can stick to `maxPages`.
- **Critique limit:** a Writer run can ask for at most 2 critiques.
- **Web tools** use Ollama's web search and fetch APIs. A guarded direct fetch is the fallback, and it blocks private and internal addresses.

## Data model (PostgreSQL)

```
users 1─1 profiles(JSON) 1─N jobs(JSON) 1─1 cvs(HTML) 1─1 cv_preferences(JSON)
                                                    └─1─1 cv_styles(raw CSS)
users 1─N chat_sessions(JSON: messages + activity)   ← independent of jobs
```

Creating a job creates its CV, its preferences and its stylesheet in one statement. Deleting a job cascades to all three. Every query is scoped to the signed-in user.

## Run locally

```bash
npm install
npm run browsers          # downloads Playwright's headless Chromium (PDF rendering)
cp .env.example .env      # optional
npm run dev               # http://localhost:3000
```

- **Database:** without `DATABASE_URL`, data goes to an embedded PGlite database in `./data/pglite`. No Postgres install or Docker is needed.
- **Models:** by default the app uses a local Ollama daemon (`http://localhost:11434`) with `kimi-k2.6:cloud`. Run `ollama signin` once so cloud models and web search work through the daemon.

## Deploy

You need any Node 22 host and a PostgreSQL database. Steps:

```bash
npm ci && npx playwright install --with-deps chromium --only-shell
npm run build
NODE_ENV=production DATABASE_URL=postgres://… OLLAMA_API_KEY=… npm start
```

- Migrations run automatically at startup.
- With `OLLAMA_API_KEY` set, the app talks to `https://ollama.com` directly and strips `:cloud` suffixes from model names.
- `NODE_ENV=production` enables Secure cookies, so serve the app over HTTPS.
- Health check: `GET /api/health`.
- Main settings, all listed in [`.env.example`](.env.example):
  - per-agent models: `COORDINATOR_MODEL`, `WRITER_MODEL`, `CRITIC_MODEL`
  - context window overrides: `*_CONTEXT_WINDOW`
  - step limits: `*_MAX_STEPS`
  - registration toggle: `ALLOW_REGISTRATION`

Notes:

- A chat run is held in process memory while it runs, so if you scale out, use sticky sessions.
- Login attempts are rate-limited per email in memory.

## Tests

```bash
npm test                  # everything (≈170 tests, ~10 s)
npm run test:unit
npm run test:integration  # real embedded Postgres + real Chromium PDFs
npm run test:e2e          # real browser driving the real server
LIVE_OLLAMA=1 npx vitest run tests/live   # opt-in: real Ollama tool calling + web search
```

The default tests use a scripted fake LLM, so they are deterministic and run offline.

| Feature | Tests |
|---|---|
| Accounts, multi-account switching, CSRF, rate limiting | `unit/password`, `integration/auth.api`, `e2e/ui` |
| Coordinator / Writer / Critic tool sets | `unit/agentTools`, `integration/agents` |
| Every data tool (read/search, write/update) | `integration/tools`, `unit/jsonOps` |
| Delegation and nested runs | `integration/agents`, `integration/tools`, `unit/activity` |
| evalMath / webSearch / webFetch (+ SSRF guard) | `unit/mathEval`, `unit/web`, `unit/netGuard`, `integration/tools` |
| Datetime and context indicator, context compaction | `unit/context`, `unit/loop`, `integration/agents` |
| Data model and isolation | `integration/repo`, `integration/data.api` |
| Skills convention and per-agent scoping | `unit/skills`, `integration/tools` |
| Activity display and context gauges | `unit/activity`, `integration/chat.api`, `e2e/ui` |
| Playwright PDF (paper size, page count, JS/network blocked) | `integration/pdf`, `e2e/ui` |
| Ollama wire format (streaming, tool calls, usage, retries) | `unit/ollama`, `live/ollama.live` |

## Security notes

- **Agent-written CV HTML:**
  - It is sanitised when saved.
  - The preview runs in a fully sandboxed iframe.
  - PDFs are rendered with JavaScript disabled and all network blocked except Google Fonts.
- **App pages:** sent with a strict CSP.
- **API:** state-changing requests must be JSON, so a cross-site form can't trigger them.
