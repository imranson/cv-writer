# CV Writer

Experimental CV writer from elicitation to CV creation, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk) and TypeScript.

You talk to one agent, the **coordinator**, from start to finish. It builds up your profile through conversation, takes the job listing, hands drafting to a separate **cv-writer** subagent, shows you each draft with its verification report, and once you approve, exports a submission-ready CV (Markdown, print-ready HTML and PDF).

## Running it

```sh
npm install
npm start                       # new conversation
npm start -- --resume <id>      # continue a previous one (the id is printed when a session ends)
npm start -- --help             # all options: --data, --model, --writer-model, --budget
```

Authentication is the same as Claude Code's: an existing `claude` login or `ANTHROPIC_API_KEY`. Both agents default to `claude-opus-5-5`. PDF export uses a local Chrome/Chromium/Edge install (or `CHROME_PATH`); without one you get Markdown and HTML only.

In the terminal, pasted multi-line text arrives as one message. You can also wrap long text in `"""` lines. Type `/quit` (or Ctrl+D) to leave. Everything is saved as you go.

## How it works

```
user ⇄ TerminalIO ⇄ runConversation ──streaming input──▶ Agent SDK query()
                                                          │
                     coordinator (system prompt, effort: medium)
                       ├─ profile / job / approval tools ─┐
                       └─ Agent tool ─▶ cv-writer subagent (effort: high)
                                          └─ read tools + save_cv_version
                                                          │
                                   in-process MCP server "cv" ─▶ CvStore (JSON files)
```

- **One conversation, one agent.** `src/app/session.ts` keeps a single SDK session open in streaming-input mode and feeds it one user turn after each completed agent turn.
- **Separate CV agent.** `cv-writer` is an SDK `AgentDefinition` with its own prompt and a narrow tool list. It reads the profile and job, writes a structured CV that cites the profile entries it uses, saves it, and fixes whatever verification flags.
- **Role separation is enforced, not just prompted.** A `PreToolUse` hook (`src/agents/policy.ts`) allows only the cv-writer to save CVs, keeps profile and approval tools with the coordinator, and stops the coordinator from starting any other agent. Denials are audited.
- **Isolated from your Claude Code setup.** No settings files, CLAUDE.md, configured MCP servers, claude.ai connectors or built-in coding tools; only `Agent`, `WebFetch` (for job URLs) and the app's own tools.
- **Verification** (`src/cv/verify.ts`) runs on every saved version: unknown or missing citations, placeholders, numbers that appear nowhere in the profile, empty sections, name and email mismatches, length, and job-keyword coverage. Versions with errors cannot be approved.

## Stored data

Everything lives under `data/` (git-ignored) as plain JSON you can inspect:

| Path | Contents |
| --- | --- |
| `profile.json` | Current profile: contact, career goal, entries (education, experience, projects, …), skills, other facts |
| `profile-history.jsonl` | Every profile change, with a full snapshot per revision |
| `jobs/<jobId>.json` | Job listings, with the full text verbatim |
| `cvs/<jobId>/v001.json` | Every CV iteration: structured document, Markdown, verification report, the profile revision it used, the version it revised, and the feedback it addresses |
| `output/<jobId>/` | Approved exports (`.md`, `.html`, `.pdf`) |
| `audit.jsonl` | Every state-changing tool call and every denied call, with its actor |

Any CV can be traced back to the exact profile it was written from: `profileRevision` points into `profile-history.jsonl`.

## Tests

```sh
npm test                 # unit + integration (no API calls)
npm run test:unit
npm run test:integration
npm run test:live        # real end-to-end run against the model (spends API credit; $5 cap)
npm run typecheck
```

- **Unit** (`tests/unit`): profile operations, rendering, verification rules, export, store (including concurrent writes and path safety), tool handlers, access policy, agent options, config, the session loop and the terminal input handling.
- **Integration** (`tests/integration`): tools called over the real MCP protocol (schemas, validation), the full profile → job → draft → revision → approval lifecycle with real PDF export, the coordinator conversation driven through the real options, hook, MCP server and store by a scripted model, and the CLI.
- **Live** (`tests/live`): the real coordinator and cv-writer, with a simulated user, from greeting to an approved, exported CV.
