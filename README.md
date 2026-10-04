# CV Writer

Experimental CV writer from elicitation to CV creation, built in TypeScript on [Ollama](https://ollama.com) cloud models.

You talk to one agent, the **coordinator**, from start to finish. It builds up your profile through conversation, takes the job listing, hands drafting to a separate **cv-writer** agent, shows you each draft with its verification report, and once you approve, exports a submission-ready CV (Markdown, print-ready HTML and PDF).

## Running it

```sh
npm install
ollama signin                   # once, so the local Ollama can run cloud models
npm start                       # new conversation
npm start -- --continue         # continue the most recent conversation
npm start -- --resume <id>      # continue a specific one (the id is printed when a session ends)
npm start -- --help             # all options
```

By default both agents run on Ollama cloud models through your local Ollama (`http://127.0.0.1:11434`): `glm-5.3:cloud` for the coordinator and `deepseek-v4-pro:cloud` for the cv-writer. Change them with `--model` / `--writer-model` (or `CV_WRITER_MODEL` / `CV_WRITER_WRITER_MODEL`). To skip the local daemon, set `OLLAMA_API_KEY` and the app calls `https://ollama.com` directly (model names work either way; the `:cloud` suffix is dropped for the direct API). `--think off|on|low|medium|high` sets reasoning for models that support it.

PDF export uses a local Chrome/Chromium/Edge/Brave (or `CHROME_PATH`); without one you get Markdown and HTML only. If you give a job URL instead of pasting the listing, the page is fetched directly, or through Ollama's web fetch when `OLLAMA_API_KEY` is set.

In the terminal, pasted multi-line text arrives as one message. You can also wrap long text in `"""` lines. Type `/quit` (or Ctrl+D) to leave. Everything is saved as you go.

## How it works

```
user ⇄ TerminalIO ⇄ runConversation ⇄ coordinator Agent ──chat + tools──▶ Ollama (cloud model)
                                          │
                     profile / job / CV tools ──▶ CvStore (JSON files)
                                          │
                                       write_cv
                                          ▼
                                   cv-writer Agent ──chat + tools──▶ Ollama (cloud model)
                                          └─ save_cv_version ─▶ verify ─▶ CvStore
```

- **Agent loop** (`src/agents/agent.ts`): a small tool-calling loop over Ollama's chat API. Each agent has its own system prompt, model and tool list; arguments are validated with zod before a tool runs, and validation errors, refusals and failures go back to the model so it can correct itself.
- **One agent talks to the user.** The coordinator (`src/agents/coordinator.ts`) owns the conversation, the profile, job listings and approval. Its replies are the only agent text the user sees.
- **Separate CV agent.** `write_cv` starts the cv-writer (`src/agents/cvWriter.ts`) in a fresh context with a brief containing the job, the profile and, for revisions, the version to revise and the user's feedback verbatim. Its only tool is `save_cv_version`, which verifies each draft and tells it whether to fix and save again (at most three saves per run).
- **Role separation is structural.** An agent can only call the tools it was given: the coordinator cannot save CVs and the writer cannot touch the profile or approve. Attempts are refused and audited.
- **What you see is what's stored.** The app shows each CV draft straight from storage; the coordinator only summarises the checks, so a draft is never retyped by a model on the way to you.
- **Verification** (`src/cv/verify.ts`) runs on every saved version: unknown or missing citations of profile entries, placeholders, numbers that appear nowhere in the profile, empty sections, name and email mismatches, length, and job-keyword coverage. Versions with errors cannot be approved.
- **Robust to open models**: nulls in tool arguments are treated as absent, version numbers sent as strings are coerced, empty replies are retried once, transient Ollama errors (429/5xx/network) are retried with backoff, and long conversations drop the oldest bulky tool outputs before the context fills.

## Stored data

Everything lives under `data/` (git-ignored) as plain JSON you can inspect:

| Path | Contents |
| --- | --- |
| `profile.json` | Current profile: contact, career goal, entries (education, experience, projects, …), skills, other facts |
| `profile-history.jsonl` | Every profile change, with a full snapshot per revision |
| `jobs/<jobId>.json` | Job listings, with the full text verbatim |
| `cvs/<jobId>/v001.json` | Every CV iteration: structured document, Markdown, verification report, the profile revision it used, the version it revised, the feedback it addresses, and the writer run that produced it |
| `writer-runs/<runId>.json` | Every cv-writer run: model, system prompt, brief, full transcript, versions saved, outcome and token usage |
| `sessions/<sessionId>.json` | Coordinator conversations (tool calls and results included), used for `--resume` / `--continue` |
| `output/<jobId>/` | Approved exports (`.md`, `.html`, `.pdf`) |
| `audit.jsonl` | Every state-changing tool call, every failed or refused call, with its actor |

Any CV can be traced back to the exact profile it was written from (`profileRevision` points into `profile-history.jsonl`) and to the conversation that wrote it (`writerRunId` → `writer-runs/`).

## Tests

```sh
npm test                 # unit + integration (no model calls)
npm run test:unit
npm run test:integration
npm run test:live        # real end-to-end run on Ollama cloud models (uses your Ollama quota)
npm run typecheck
```

- **Unit** (`tests/unit`): the agent loop (tool execution, validation, refusals, auditing, step limits, retries of empty replies, context compaction), the Ollama client (request shape, cloud model names, auth, retries, timeouts, error messages), the cv-writer (brief, self-correction, save limit, failure handling, run records), every coordinator tool, the session loop and resume, profile operations, rendering, verification rules, export, the store, page fetching, config and the terminal.
- **Integration** (`tests/integration`): the real `ollama` client and coordinator over HTTP against a stand-in Ollama server; the whole product from first hello to approved PDF (with headless Chrome when available) driven by scripted models through the real session, agents, store, verification and export, then resumed; and the CLI as a subprocess holding a conversation over stdin/stdout.
- **Live** (`tests/live`): the real coordinator and cv-writer on Ollama cloud, with a simulated user, from greeting to an approved, exported CV.
