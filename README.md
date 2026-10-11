# CV Writer

Experimental CV writer from elicitation to CV creation.

One coach agent (the coordinator) talks to you from start to finish: it interviews you to build a thorough profile, saves the job you are applying for, asks about gaps, delegates drafting to a **writer** subagent and grading to a **critic** subagent, and iterates with you until the CV is ready to submit as a PDF. Models are served by Ollama (cloud models by default); PDFs are rendered by headless Chromium via Playwright.

```
 Browser UI (Vite + TS)                     Node server (Hono)
┌──────────────────────────┐   SSE    ┌──────────────────────────────────────────────┐
│ chat · context meter     │◀────────▶│ ConversationService ─▶ Coordinator agent     │
│ CV preview / PDF view    │   REST   │                           │  write_cv  critique_cv
│ raw CSS + HTML editors   │◀────────▶│                           ▼            ▼     │
│ critique · job · profile │          │                      Writer agent ─▶ Critic agent
│ skills library           │          │ Store (files) · SkillLibrary · PdfRenderer   │
└──────────────────────────┘          └──────────────┬───────────────────────┬───────┘
                                                     ▼                       ▼
                                          Ollama /api/chat (tools)   Playwright Chromium
```

## Setup

Requirements: Node 20+, an Ollama account with cloud model access.

```bash
npm install
npx playwright install chromium     # browser used for PDF rendering and UI tests
```

Pick one way to reach Ollama cloud models:

- **Local daemon (default):** install Ollama, run `ollama signin`, and the app talks to `http://127.0.0.1:11434` using `kimi-k2.6:cloud`.
- **Direct API:** set `OLLAMA_API_KEY` (from ollama.com/settings/keys). The host defaults to `https://ollama.com` and `:cloud` suffixes are stripped from model names.

## Run

```bash
npm start          # builds the UI and serves everything at http://127.0.0.1:4317
npm run dev        # API with reload + Vite dev server at http://localhost:5173
```

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `OLLAMA_HOST` | `http://127.0.0.1:11434` (or `https://ollama.com` with an API key) | Ollama endpoint |
| `OLLAMA_API_KEY` | – | Bearer token for ollama.com |
| `OLLAMA_MODEL` | `kimi-k2.6:cloud` | Coordinator model (also writer/critic unless overridden) |
| `WRITER_MODEL`, `CRITIC_MODEL` | `OLLAMA_MODEL` | Per-subagent models |
| `OLLAMA_THINK` | model default | `true`/`false`/`low`/`medium`/`high` — lower is faster |
| `OLLAMA_TEMPERATURE` | model default | 0–2 |
| `CONTEXT_LENGTH` | read from `/api/show` | Override the context window used by the indicator |
| `COMPACT_THRESHOLD` | `0.8` | Fraction of the context window at which older messages are summarised |
| `DATA_DIR` | `./data` | Where everything is stored |
| `PORT` | `4317` | HTTP port |
| `BIND_ADDRESS` | `127.0.0.1` | Interface to listen on |
| `PDF_ALLOWED_HOSTS` | `fonts.googleapis.com,fonts.gstatic.com` | Only hosts the PDF renderer may fetch from |

## What's where

**Agents** (`src/agents/`)
- `coordinator.ts` — the agent you talk to. Tools: profile read/update/edit, job save/update/select, `fetch_url` for listing links, `write_cv` (→ writer), `critique_cv` (→ critic), CV/style reading, `set_style`, `export_pdf` (page count + readiness report + download link), skills. A live "current state" block (profile coverage, jobs, active CV, last score and staleness, compacted history) is added to its prompt every turn.
- `writer.ts` — writes/edits the CV as an HTML fragment (`write_cv`, `edit_cv`), sees automated check results after every save, can check page count and ask the critic once (`request_critique`).
- `critic.ts` — grades the CV against the listing (five 0–10 dimensions → weighted 0–100 score), lists requirement coverage, outright mistakes and claims not supported by the profile, then submits through a schema-validated `submit_critique` tool. The verdict (`ready` / `needs_work` / `not_ready`) is computed deterministically from the scores, mistakes, factual issues and automated checks.
- `loop.ts` — generic streaming tool-calling loop shared by all three agents.
- `conversation.ts` / `context.ts` — chat sessions, persistence of every message as it is produced, stop/busy handling, context usage (model-reported tokens vs the model's window) and automatic or manual compaction of older messages into a summary.

**CV** (`src/cv/`): deterministic checks (placeholders, missing contact, invented numbers/contact details, duplicate/long/first-person bullets, mixed date formats, length, page limit from your preferences), document assembly and sanitising, style presets, and the Playwright PDF renderer (JavaScript disabled, network blocked except allowed font hosts).

**Skills** (`skills/*.md`, plus your own in `data/skills/`): expert advice as markdown with frontmatter:

```markdown
---
name: Achievement bullets
description: One line shown to agents in the skills index
audience: [writer, critic, coordinator]
tags: [bullets]
autoload: true        # true = full text always in the agent's prompt; false = listed, read on demand
---
Advice in markdown…
```

Agents see an index of skills for their role and load them with `read_skill`. Add or override skills in the UI (Skills tab) or by dropping files into `data/skills/`; a user skill with the same id as a built-in one overrides it.

**Data** (`DATA_DIR`, git-ignored):

```
profile.md                  your profile + "## Preferences" (unstructured markdown)
jobs/<id>/listing.md        job listing (unstructured markdown) + job.json metadata
jobs/<id>/cv.html           the CV for that job (one per listing)
jobs/<id>/style.css         its stylesheet (edit raw in the UI)
jobs/<id>/critiques.json    critique history
jobs/<id>/versions/         previous CV versions (restorable)
sessions/<id>.json          chat sessions
skills/*.md                 your skills
```

## Tests

```bash
npm test                   # unit + integration (~30 s; uses real headless Chromium)
npm run test:unit
npm run test:integration
npm run test:live          # opt-in, calls the real Ollama model (several minutes)
npm run typecheck
```

- `tests/unit/` — every module: config, storage, skills, sanitising, document/PDF helpers, checks, critique scoring, the agent loop, Ollama adapter, coordinator/writer/critic tools, compaction, conversation service, URL fetching, and the web client's markdown renderer, SSE parser and CSS controls. Agents run against a scripted `ChatModel`.
- `tests/integration/` — HTTP API (incl. SSE streaming), real PDF rendering (pagination, `@page` sizes, network/JS isolation), Ollama wire protocol against a fake Ollama server, the full journey from empty profile to a submission-ready PDF, and a Playwright-driven browser test of the UI.
- `tests/live/` — the coordinator, writer and critic against the real model.
