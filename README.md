# AutoProject

A project manager where you talk to **one agent per project** — and the AI does all the work underneath.

- **A board, not a graph.** Each project is a flat board with four columns: *Blocked*, *Working*, *Ready for review*, *Done*. Cards are ordered by arrival; there are no dependencies, subgraphs or manual layout. (The earlier graph-of-tickets design lives on the `graph-era` branch.)
- **One project agent.** The bottom bar talks to a persistent agent session per project, in one of two modes:
  - **Panel** (default). Describe what should change; the agent turns it into a few large tickets through an in-process MCP tool (`add_tickets`) and records lasting preferences ("always use pnpm") as **project notes** (`set_notes`), which are injected into every ticket prompt. Cards appear live mid-turn.
  - **Act.** The chat sheet slides up over the board and the agent does the work itself in the workspace, spawning *worker* (parallel coding) and *scout* (read-only) subagents as it sees fit. Both modes share one transcript.
  - Toggle with the toolbar button or **Ctrl+M**; swipe back leaves act mode, then the project.
- **Tickets run themselves.** A new ticket starts right away as its own agent session (real file edits, bash, one commit per ticket); two tickets that list the same file run one after another. Every ticket ends in *Ready for review*: test it, send feedback (the agent resumes the same session), then approve or reject. ▶ in the toolbar re-runs whatever is left, including failed tickets.
- **Context files.** Attach files (PNGs, PDFs, anything) to the project in Settings or to any ticket; both are handed to the ticket's agent. Project description, notes and workspace dir are edited in Settings too.
- **Projects are folders.** A new project creates a folder under `~/Documents/personal` (override with `AUTOPROJECT_HOME`); the agent works right in it. Import any existing folder from the picker — its `.autoproject` state is adopted, or created on the spot (older graph-shaped files are migrated). Project state is autosaved under `<workspace>/.autoproject/`; no database, no login.

## Setup

```bash
npm install
./bin/autoproject
```

The launcher builds and starts the production app at `http://127.0.0.1:4123`, reusing an existing server on that port. It resolves its checkout from its own location, including symlinks, and opens the browser on macOS or Linux. Use `./bin/autoproject --dev` for development with hot reload, `--port 5000` for another port, or `--no-open` to print the URL. A new production server always builds current source first. Logs go to `~/.autoproject/server.log`; `AUTOPROJECT_STATE_DIR` changes that directory and `AUTOPROJECT_START_TIMEOUT` changes the 60-second readiness timeout.

Choose the agent model in **Settings**. Claude models run through the Claude Agent SDK, Codex models through the Codex CLI, and Gemini models through the local Antigravity CLI (`agy`). The board MCP tool and act-mode subagents are Claude-only; Codex and Gemini panel turns use structured output and act mode works alone. Claude runs are capped at a 200k-token context.

Opening Settings never checks the model catalog: it answers from the stored one, so the dropdown is usable immediately. **Refresh models** is the only thing that runs discovery. Concurrent refresh requests share the in-flight check. Each provider has a **12-second timeout** and fails independently, so an unavailable tool does not discard the other providers' results.

Discovery uses the existing tools and their local authentication, without new API credentials or inference turns:

- **Codex:** the installed CLI's [app-server `model/list` RPC](https://learn.chatgpt.com/docs/app-server#list-models-modellist), including pagination and reported reasoning options. New IDs such as `gpt-6.1-sol` appear when returned by that CLI; AutoProject does not maintain a version-specific allowlist.
- **Claude:** the installed Claude Agent SDK's `supportedModels()`, listing each model once under the name the SDK reports, with its supported effort levels.
- **Gemini:** `agy models`, grouping only the Gemini variants actually listed. Other providers exposed by `agy` are excluded so their routing stays with the existing integrations.

Only the newest release of each model family is offered: `gpt-6.1-sol` replaces `gpt-6-sol` and `gpt-5.6-sol`, while a family with no newer release stays listed. This compares the version inside each ID rather than a fixed list, so a future release supersedes its predecessors without a code change. A saved model that this hides stays visible and selectable.

The last successful catalog for each provider is stored in `~/.autoproject/model-catalog.json` and survives server restarts. Discovery failures use that provider's saved catalog, or bundled defaults when it has never succeeded. Settings names any provider it could not reach. An unreadable cache falls back to memory or bundled defaults; an unwritable cache still permits discovery for the current server process. The tools may themselves return cached or bundled catalogs; a listed model is not a guarantee of account access.

**Refresh never changes the selected model or writes your settings.** Saved models missing from discovery stay visible as “saved selection,” and previously discovered routing and capabilities are retained in a bounded history. Only Save changes `~/.autoproject/config.json`; selecting a different provider starts a compatible session rather than resuming another provider's session.

The **Reasoning level** control uses the same catalog as config validation and agent execution. It preserves a supported saved level, otherwise uses **High** when supported, then the model's reported default. If capability metadata is unknown, AutoProject leaves reasoning at the CLI default rather than guessing. When a model reports levels but no resolvable default, the slider offers an explicit **CLI default** position; saving it clears the stored level instead of keeping the previous one. Claude receives the SDK's `effort`, Codex receives `model_reasoning_effort`, and Gemini receives an exact listed model variant. Reasoning changes apply to subsequent turns, including resumed sessions. Bundled defaults remain available when discovery has never succeeded; refreshed metadata takes precedence over those defaults.

For Claude, the app picks up your local login automatically. On a server, set **one** of:

- `CLAUDE_CODE_OAUTH_TOKEN` — subscription auth (Pro/Max/Team/Enterprise limits, no per-token billing). Generate with `claude setup-token`. Personal token: keep the deployment access-protected, since anyone using the app consumes your limits.
- `ANTHROPIC_API_KEY` — pay-per-token API billing.

For Codex, install the CLI and sign in once with your ChatGPT/Codex account:

```bash
npm install -g @openai/codex
codex login
```

AutoProject reuses that saved CLI login. If `codex` is not on the server process's `PATH`, set `AUTOPROJECT_CODEX_PATH` to the executable path.

For Gemini, install the Antigravity CLI (`agy`) and authenticate. AutoProject reuses the terminal's active `agy` login. If `agy` is not on the server process's `PATH`, set `AUTOPROJECT_AGY_PATH` to the executable path.

AutoProject is designed to run **locally** — projects are folders on your machine and the agent edits them in place. A Vercel deployment builds and runs, but its filesystem is ephemeral, so it's only useful for demos.

## Scheduling and recovery

Ticket runs keep ownership of their declared files and worker until the process exits, including after a card is removed or marked done. Duplicate starts cannot open a second agent for the same ticket. Stop Project stops both ticket agents and the project agent, cancels pending work, and pauses waiting tickets; erasing a project waits for its processes and scheduler to finish before removing files.

Ticket and project-agent turns, across every open project, share a limit of **100 active provider calls overall** and **100 per provider** — a safety net against a runaway bug, not a throttle. Set positive integer environment variables on the server to change those limits:

- `AUTOPROJECT_MAX_RUNS`
- `AUTOPROJECT_MAX_CLAUDE_RUNS`
- `AUTOPROJECT_MAX_CODEX_RUNS`
- `AUTOPROJECT_MAX_GEMINI_RUNS`

Waiting calls can be stopped without starting a provider process. Claude's internal subagents are part of their parent turn and are not counted separately by these limits.

Queued feedback and project-agent requests are persisted with project state. Queued requests resume when the project is loaded after a server restart; a request interrupted mid-turn remains visible with an error for an explicit retry. Commands acknowledge acceptance promptly, while the event stream carries progress and completion. Autosaves and command acknowledgements report persistence failures instead of silently discarding them.

## Saving and large projects

Edits are saved through a separate, ordered queue for each project. Leaving a project waits for acknowledgement; failures keep the edits and show a retry control. A tab stores pending field changes in session storage for reload recovery when browser storage permits, and warns before closing with unsaved edits. Changes to different fields merge across tabs. Same-field conflicts keep your draft and require **Retry saving my edits** to explicitly apply it over the latest server value.

Snapshots use atomic replacement after serialized writes. Attachments are stored once by content hash under `.autoproject/attachments/`; existing inline attachments migrate when a project is next saved. The live snapshot retains the latest 1,000 log entries per ticket and 2,000 project chat entries. Full output remains in `.autoproject/history.jsonl`, with paginated download from the transcript view. History pagination uses opaque byte cursors: pass each returned `nextCursor` unchanged until it is `null`. Pages seek directly to that position instead of rereading earlier output. Back up the whole `.autoproject` directory, including attachments and history.

The board shares a file/worker index and memoized cards; output from one ticket does not recompute every card's contention or layout. Transcript views render at most 200 entries at once. The project picker caches file summaries and pauses polling in background tabs.

Run checks with `npm test`, `npm run lint`, and `npm run build`. Tests use temporary workspaces and fake provider executables. Reproduce the board indexing benchmark with `node --import ./test/ts-resolve.mjs scripts/benchmark-board.mts`.

## Architecture

- `lib/types.ts` — flat project/ticket model, board columns, file-claim helpers
- `lib/store.ts` — zustand store (incl. the panel/act mode); `lib/sync.ts` autosaves and follows the server's SSE feed
- `lib/save-queue.ts`, `project-edits.ts`, `project-events.ts` — acknowledged field saves, conflict comparisons, and shared feed contracts
- `lib/board-index.ts` — shared file and worker contention index
- `lib/run-state.ts` — who owns what: the server owns the ticket set and run fields, the browser the user-edited ones
- `lib/projects-fs.ts` — projects on disk: `<workspace>/.autoproject/project.json`, imports registry in `~/.autoproject/imports.json`
- `lib/server/project-store.ts` — in-memory projects, serialized persistence, and the event bus
- `lib/server/project-attachments.ts`, `project-history.ts` — immutable attachment assets and full output history
- `lib/server/runs.ts` — ticket scheduling (file claims, auto-run), review gating, feedback via session resume
- `lib/server/run-registry.ts`, `run-limiter.ts`, `ticket-session.ts`, `project-lifecycle.ts` — process ownership, shared capacity, ticket execution, and orderly project removal
- `lib/server/project-agent.ts` — the project agent: one resumed session, panel/act preambles, worker/scout subagents
- `lib/server/board-tools.ts` — the in-process MCP server (`add_tickets`, `set_notes`) and the structured-output fallback
- `lib/server/agent.ts`, `agent-types.ts` — provider interface and dispatch to `claude.ts`, `codex.ts`, or `gemini.ts`
- `lib/server/cli-process.ts`, `board-schema.ts` — shared process lifecycle and planner validation
- `app/api/agent`, `app/api/runs`, `app/api/projects` — agent turns, ticket runs + SSE stream, project CRUD
- `components/` — project picker (meta graph), board, act sheet, bottom bar, toolbar, settings
