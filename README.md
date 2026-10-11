# CV Writer

Experimental CV writer from elicitation to CV creation: a web app where one coordinator agent talks to you from first hello to finished CV, delegating to writer and critic subagents. Runs on Ollama cloud models, written in TypeScript, renders PDFs with Playwright.

## Quick start

```bash
npm install
npx playwright install chromium   # once, for PDF rendering
ollama signin                     # once, so the local daemon can serve cloud models
cp .env.example .env              # optional: model, API key, port
npm start                         # http://localhost:4817
```

By default the app talks to the local Ollama daemon (`OLLAMA_HOST=http://127.0.0.1:11434`) using `kimi-k2.6:cloud`. To call ollama.com directly instead, set `OLLAMA_HOST=https://ollama.com`, `OLLAMA_API_KEY` and a model name such as `gpt-oss:120b`. Web search needs `OLLAMA_API_KEY`; web fetch falls back to a guarded direct fetch without it.

| Variable | Default | Purpose |
| --- | --- | --- |
| `OLLAMA_MODEL` | `kimi-k2.6:cloud` | Model for all agents |
| `COORDINATOR_MODEL`, `WRITER_MODEL`, `CRITIC_MODEL` | `OLLAMA_MODEL` | Per-agent override |
| `OLLAMA_HOST` | `http://127.0.0.1:11434` | Ollama daemon or `https://ollama.com` |
| `OLLAMA_API_KEY` | – | Web search/fetch API, and auth for ollama.com |
| `OLLAMA_THINK` | model default | `true`/`false`/`low`/`medium`/`high`; `false` is much faster |
| `CONTEXT_WINDOW` | read from the model | Context window shown to agents and in the UI |
| `MAX_AGENT_STEPS` | `30` | Tool-call rounds per agent run |
| `PORT`, `DATA_DIR`, `SKILLS_DIR` | `4817`, `./data`, `./skills` | Server and storage |

## Agents

| Agent | Talks to user | Tools |
| --- | --- | --- |
| Coordinator | yes (only one) | readProfile, writeProfile, editProfile, readJob, writeJob, editJob, searchJobs, callWriter, callCritic |
| Writer | no, reports to coordinator | readCV, writeCV, editCV (HTML, CSS and per-CV preferences), searchCVs, readProfile, callCritic |
| Critic | no, reports to its caller | readCV, readJob, searchCVs, searchJobs |

Every agent also has `evalMath`, `webSearch`, `webFetch`, and sees the current date/time and its own context window usage in its system prompt on every step. `callWriter` attaches the job record to the writer's brief because the writer has no `readJob`. Subagent text never reaches the chat; their tool activity shows up in the activity log.

## Data

Schemaless and loosely linked by id, one directory per type under `DATA_DIR`:

```
profiles/<profileId>.json        user profile
jobs/<jobId>.json                job, linked to a profile via profileId (1 profile → N jobs)
cvs/<jobId>.html                 CV body HTML (1 job → 1 CV)
cv-preferences/<jobId>.json      per-CV preferences (1 CV → 1)
cv-styles/<jobId>.css            CV stylesheet, editable raw in the UI (1 CV → 1)
sessions/<chatId>.json           chat sessions, independent of everything else
```

## Skills

`skills/coordinator/`, `skills/writer/`, `skills/critic/`: every `*.md` in an agent's directory is appended to that agent's system prompt on each run (optional `name`/`description` frontmatter). Add files to extend an agent without code changes.

## Tests

```bash
npm test                 # unit + integration (scripted model, real Playwright browser and PDF)
npm run test:unit
npm run test:integration
npm run test:live        # real Ollama cloud model (LIVE=1)
npm run typecheck
```

## Layout

```
src/agents     agent loop, runtime/delegation, prompts, context meter
src/tools      tool framework (zod → JSON schema), data tools, common tools, web client
src/storage    file stores and the workspace data model
src/llm        Ollama streaming client
src/chat       chat sessions and turn execution
src/cv         default CSS, document rendering, Playwright PDF
src/server     Hono HTTP API + SSE, esbuild client bundling
src/client     browser UI (TypeScript)
public         HTML shell and app styles
skills         per-agent skills
tests          unit, integration, live
```
