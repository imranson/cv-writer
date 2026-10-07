# CV Writer

A web app that takes you from first hello to a CV you can submit, built in TypeScript on [Ollama](https://ollama.com) cloud models.

You talk to one agent, the **coach** (coordinator), from start to finish. It interviews you to build a profile that grows over time, takes a job listing, checks your fit, hands drafting to a separate **writer** agent, which has each draft graded by a separate **critic** agent, walks you through revisions, and exports the approved CV as a styled PDF. Everything is stored for verification and auditing.

## Running it

```sh
npm install
ollama signin            # once, so your local Ollama can run cloud models
npm start                # builds the UI and serves http://127.0.0.1:5174
npm start -- --help      # options
```

Defaults: coach `glm-5.3:cloud`, writer `deepseek-v4-pro:cloud`, critic `glm-5.3:cloud`, all through your local Ollama (`http://127.0.0.1:11434`). Change them with `--model`, `--writer-model`, `--critic-model` (or `CV_WRITER_MODEL`, `CV_WRITER_WRITER_MODEL`, `CV_WRITER_CRITIC_MODEL`). `kimi-k2.6:cloud` is a stricter critic but takes several minutes per review. To skip the local daemon, set `OLLAMA_API_KEY` and the app calls `https://ollama.com` directly. `--think off|on|low|medium|high` sets reasoning effort for models that support it.

PDF export uses a local Chrome, Chromium, Edge or Brave (or `CHROME_PATH`); without one you still get the live preview, HTML and Markdown. The server listens on 127.0.0.1 only, since there is no login.

`npm run dev` restarts the API on changes; run `npx vite` alongside it for a hot-reloading UI on port 5173 (it proxies `/api`).

## Using it

- **Chat (left)** — the coach leads: it asks one or two questions at a time, saves what you say to your profile as you go, asks for a job listing (paste it, or give a URL), asks about requirements your profile doesn't yet evidence, then drafts. You see what each agent is doing as it happens (“Writer saved v2”, “Critic scored v2 82/100”).
- **CV** — live preview of any version, PDF preview and download, Markdown download.
- **Review** — the critic's score, verdict, sub-scores, issues with suggestions, requirement-by-requirement coverage and questions for you, plus the automatic checks re-run against your current profile.
- **Style** — typeface (body and headings), text and name size, line spacing, margins, spacing between sections/entries/bullets, paper size, header alignment, section-title style, bullet character, accent colour, and presets (classic, modern, compact, airy). The preview updates instantly; the PDF uses the saved style. You can also just ask the coach (“use Garamond and tighter margins”).
- **Profile**, **Job**, **History** — everything stored about you (with the change history), the listing verbatim, and the audit log.

## How it works

```
browser ⇄ HTTP + server-sent events ⇄ coordinator agent ─┬─ profile / job / style tools ─▶ Store (JSON files)
                                                         ├─ write_cv ──▶ writer agent ─┬─ save_cv ─▶ checks ─▶ Store
                                                         │                              └─ request_critique ─┐
                                                         ├─ critique_cv ─────────────────────────────────────┴─▶ critic agent ─▶ Store
                                                         └─ approve_cv / export_cv ─▶ render HTML ─▶ headless Chrome ─▶ PDF
```

- **Agent loop** (`src/agents/agent.ts`): a tool-calling loop over Ollama's chat API. Each agent has its own model, system prompt and tool list; arguments are validated with zod before a tool runs, and validation errors, refusals and failures go back to the model so it can correct itself. An agent can only call its own tools — anything else is refused and audited.
- **Coordinator** (`src/agents/coordinator.ts`): the only agent the user talks to. Its system prompt is rebuilt every step with the live state — the profile, deterministic profile gaps to ask about, saved jobs, the active listing, CV versions with check and review results — so it always knows what to ask next. Job listings are stored verbatim from the user's message or the fetched page; the model never retypes them.
- **Writer** (`src/agents/writer.ts`): drafts or revises in a fresh context with a brief containing the task, the user's feedback verbatim, the version to revise and its last review, the listing, and the profile as the only source of facts. Every save is checked; it must fix errors, then ask the critic for a review and fix what it can (up to 4 saves and 2 reviews per run). It ends with questions only the user can answer, which the coach then asks.
- **Critic** (`src/agents/critic.ts`): grades a version against the listing (fit, strength, outright mistakes, correctness against the profile) and submits a structured review. The rubric is enforced in code: anything untrue to the profile is critical, and the verdict can't be better than the worst issue.
- **Automatic checks** (`src/cv/checks.ts`) on every version: name/email/phone/links must match the profile, every entry must cite real profile entries, years must match the cited entries' dates, every number must appear in the profile, no placeholders or empty sections; warnings for unknown skills, long or duplicate bullets and length; job keyword coverage.
- **Approval** (`approve_cv`) is refused while a version has check errors (re-run against the current profile), has not been reviewed, or has critical review issues. Approval exports PDF, HTML and Markdown with the exact style recorded.
- **PDF** (`src/cv/pdf.ts`, `src/cv/render.ts`, `src/cv/style.ts`): one HTML renderer drives the browser preview and the PDF, so what you see is what you get. Layout stays in normal flow so ATS parsers read the PDF text in order.
- **Robust to open models**: nulls in tool arguments count as absent, string numbers are coerced, common enum spellings are accepted, leaked `</think>` reasoning is stripped, empty replies are retried once, transient Ollama errors are retried with backoff, stalled streams time out, and long conversations shed old bulky tool output before the context fills.

## Stored data

Everything lives under `data/` (git-ignored) as plain JSON:

| Path | Contents |
| --- | --- |
| `profile.json` | Current profile: contact, career goal, entries (experience, education, projects, …) with highlights and skills, skill groups, other facts |
| `profile-history.jsonl` | Every profile change: operation, actor, reason, payload, full snapshot |
| `jobs/<jobId>.json` | Job listings, verbatim, with extracted requirements and keywords |
| `cvs/<jobId>/v001.json` | Every CV iteration: document (with profile citations), checks, every critic review, the profile revision it was written from, the version it revises, the user feedback it addresses, the writer run, approval and every export with its style |
| `runs/<runId>.json` | Every writer and critic run: model, system prompt, brief, full transcript, outcome, token usage |
| `sessions/<id>.json` | Conversations: what the user saw and the coach's model history |
| `style.json` | Current CV style |
| `output/<jobId>/` | Exported PDF, HTML and Markdown |
| `audit.jsonl` | Every state change and every failed or refused action, with its actor (user, coordinator, writer, critic) |

Any CV traces back to the exact profile it was written from (`profileRevision` → `profile-history.jsonl`) and to the agent runs that wrote and reviewed it (`writerRunId`, `critiques[].runId` → `runs/`). Profiles and job listings saved by the previous (terminal) version of the app load as they are; its CV versions, sessions and audit lines use another format, so they stay on disk untouched but are not shown (new CV versions continue the numbering).

## Tests

```sh
npm test                 # unit + integration (no model calls)
npm run test:unit
npm run test:integration
npm run test:live        # the real product on Ollama cloud models (uses your quota; CV_WRITER_KEEP=1 keeps the data)
npm run typecheck
```

- **Unit** (`tests/unit`): profile operations and gap analysis; storage (history, versions, sessions, audit, concurrency, old formats); every check rule; HTML/Markdown rendering, escaping and styles; the agent loop (tools, validation, refusals, reminders, step limits, streaming, progress, context compaction); the Ollama client (wire format, auth, streaming, retries, idle timeouts, reasoning leaks); writer, critic and every coordinator tool; export; page fetching; config; the browser's SSE parser and chat Markdown.
- **Integration** (`tests/integration`): the HTTP API and SSE conversation stream; the whole journey from greeting through interview, listing, drafting, review, revision from feedback, restyling and approval to a real PDF; the coordinator over the Ollama wire protocol against a stand-in server; real Chrome output (paper size, typeface, spacing vs page count); the built UI being served.
- **Live** (`tests/live`): a simulated user talking to the real agents until a CV is approved.
