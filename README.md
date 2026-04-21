# Tokenius

> A streaming-first AI coding agent built from scratch — direct SDK integration, tool-driven architecture, zero framework bloat.

Tokenius is a single-process, terminal-native coding agent that reads, writes,
searches, and runs code through a small set of tools. It streams every model
response, persists every session to disk as JSONL, and wires security into
each tool instead of bolting it on afterwards.

No LangChain, no AI SDK, no agent framework. Just the Anthropic and OpenAI
SDKs, Bun, and about 5k lines of TypeScript.

## Install

Requires [Bun](https://bun.sh) 1.3+.

```bash
bun add -g tokenius
```

Or from source:

```bash
git clone <repo> tokenius
cd tokenius
bun install
bun link
```

Set an API key for the provider you want to use:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
# or
export OPENAI_API_KEY=sk-...
```

Bun auto-loads `.env` from the current working directory, so a project-local
`.env` file works too.

## Quick Start

```bash
cd your-project
tokenius
```

You're dropped into a REPL. Ask for anything a coding agent would do:

```
> explain how the agent loop terminates
> add a test for calculateCost that covers cache tokens
> find every call site of loadConfig and add a debug log
> /cost
> /sessions
> /quit
```

Ctrl+C aborts the current turn; pressing it twice in a row exits.

## Architecture

Tokenius is a layered system. Each layer depends only on the layers below it,
so every layer can be reasoned about (and tested) on its own.

```
┌─────────────────────────────────────────┐
│          CLI / REPL Interface           │  Layer 9
├─────────────────────────────────────────┤
│     Configuration & Project Rules       │  Layer 8
├─────────────────────────────────────────┤
│              Skills                     │  Layer 7
├─────────────────────────────────────────┤
│        Session Persistence              │  Layer 6
├─────────────────────────────────────────┤
│              Security                   │  Layer 5
├─────────────────────────────────────────┤
│        Agents & Subagents               │  Layer 4
├─────────────────────────────────────────┤
│           Agent Loop                    │  Layer 3
├─────────────────────────────────────────┤
│           Tool System                   │  Layer 2
├─────────────────────────────────────────┤
│      LLM Provider Abstraction           │  Layer 1
└─────────────────────────────────────────┘
```

**Data flow for one user message:**

```
User input
  → CLI parses (skill? slash command? prompt?)
  → Load agent config (build by default)
  → Agent loop
     ├─ check context window (hard stop if exceeded)
     ├─ stream model response (retry on 429/5xx)
     ├─ extract tool calls
     ├─ validate + security-check + batch permission prompts
     ├─ run tools sequentially
     └─ loop back if tools were called
  → Persist messages to ~/.tokenius/sessions/<id>.jsonl
  → Render final response
```

For the full architectural treatment, see
[`docs/PLAN.md`](./docs/PLAN.md). For the _why_ behind each major design
choice, see [`docs/DECISIONS.md`](./docs/DECISIONS.md).

## Design Principles

- **One loop, many agents** — the agent loop is a single function. Agents
  (`build`, `plan`, `explore`) are configurations of a system prompt plus a
  tool allowlist. No per-agent code.
- **Tools are the API** — everything the model does goes through a tool call.
  No hidden side effects, no special-cased behaviors.
- **Security by default** — path validation, command gating, and secrets
  detection are wired into each tool at construction time, not layered on top.
- **Streaming-first** — every provider call yields a stream. Text, tool
  arguments, and thinking blocks are parsed incrementally.
- **Simple persistence** — append-only JSONL. No database, no compaction, no
  custom format.
- **Direct SDKs** — `@anthropic-ai/sdk` and `openai` are called directly.
  Every abstraction in the codebase exists because Tokenius needs it.

## Agents

Three agent configurations ship out of the box. Switching between them is a
matter of system prompt + tool list.

| Agent     | Tools                                            | Use case                             |
| --------- | ------------------------------------------------ | ------------------------------------ |
| `build`   | read, write, edit, grep, glob, bash, spawn_agent | Full access — the default REPL agent |
| `plan`    | read, grep, glob                                 | Read-only planner for design work    |
| `explore` | read, grep, glob                                 | Fast codebase search + Q&A           |

The `build` agent can delegate to `plan` or `explore` via the `spawn_agent`
tool, which spins up a fresh loop with its own context window and reports back
with the subagent's final message and cost.

## Tools

Every tool validates its inputs with Zod, enforces path/command/secret
constraints, and truncates its output so the model never receives unbounded
content.

| Tool          | What it does                                                         |
| ------------- | -------------------------------------------------------------------- |
| `read`        | Read a file with offset/limit, binary detection, path validation     |
| `write`       | Create or overwrite files, mkdir -p parents, secret-block on payload |
| `edit`        | Exact-match single or `replace_all` edits, secret-block on result    |
| `grep`        | Ripgrep if available, pure-Bun walker fallback with size caps        |
| `glob`        | Sorted file discovery via `Bun.Glob`                                 |
| `bash`        | Execute shell commands with timeout + command detection              |
| `spawn_agent` | Spawn a `plan` or `explore` subagent for scoped exploration          |

## Slash Commands

| Command                | Effect                                                        |
| ---------------------- | ------------------------------------------------------------- |
| `/help`                | List available commands                                       |
| `/cost`                | Show total cost + token usage for this session                |
| `/usage`               | Detailed stats: session id, title, context-window utilization |
| `/sessions`            | List recent sessions (most recent first)                      |
| `/load <id>`           | Resume a previous session                                     |
| `/clear`               | Start a fresh session (previous stays on disk)                |
| `/skills`              | List skills discovered in `.tokenius/skills/`                 |
| `/skill:<name> <args>` | Invoke a skill by name                                        |
| `/quit`, `/exit`       | Exit the REPL                                                 |

## Configuration

Tokenius reads optional project-local config from the current working
directory. Every file is optional — Tokenius works with zero configuration.

### `tokenius.json`

Selects provider and model. Unknown keys are rejected (typos fail fast).

```jsonc
{
  "provider": "anthropic",
  "model": "claude-sonnet-4-6",
}
```

The `openai` provider also supports a `baseUrl` override, which makes it a
drop-in client for any OpenAI-compatible service (xAI, DeepSeek, GLM, Kimi,
local llama.cpp, etc.):

```jsonc
{
  "provider": "openai",
  "model": "deepseek-chat",
  "baseUrl": "https://api.deepseek.com/v1",
}
```

### `AGENTS.md`

A Markdown file at the project root. If present, its contents are appended to
the system prompt on every turn — the right place to document repo-specific
conventions (commit style, test commands, things to avoid).

### `.tokenius/skills/`

Each subdirectory is a skill. The `SKILL.md` inside can carry YAML
frontmatter; invoke it from the REPL with `/skill:<name>`. Skills are
prompt-level building blocks, not code — they only append to the system
prompt.

## Session Persistence

Every turn is appended to `~/.tokenius/sessions/<session-id>.jsonl` as it
happens. Sessions are plain JSONL, so `cat`, `jq`, and `less` all just work.
The first session Tokenius writes in a new project prints a one-time reminder
to add `.tokenius/` to `.gitignore`.

Session IDs are UUIDs. Titles are generated asynchronously from the first
user message so `/sessions` has something to display.

## Security

Dangerous things happen at tool boundaries, so security lives there too:

- **Path validation** — all file tools reject paths outside the project root
  and a small blocklist (`.env`, `.git`, SSH keys, `node_modules` for writes).
- **Command detection** — `bash` has an allowlist of safe read-only commands
  (ls, cat, git status, …), a blocklist of destructive ones (rm -rf /, curl |
  sh, …), and everything else triggers a batched permission prompt.
- **Secrets detection** — `write` and `edit` scan their payloads for API key
  patterns and refuse to write them to disk.
- **Permissions are session-sticky** — once you approve a command, the same
  pattern won't prompt again until the session ends.

## Development

```bash
bun install                      # install deps
bun run dev                      # REPL with watch mode
bun run build                    # bundle to dist/index.js with shebang
bun test                         # run tests
bun run check                    # lint + format + typecheck + knip + tests
```

Test files live next to their source (`*.test.ts`). Pre-commit hooks
(lefthook) run the full check suite.

### Tech Stack

- [**Bun**](https://bun.sh) — runtime, bundler, test runner, package manager
- **TypeScript** with the strictest settings
- [**oxlint**](https://oxc.rs/docs/guide/usage/linter) + [**oxfmt**](https://oxc.rs/docs/guide/usage/formatter) — lint and format
- [**knip**](https://knip.dev) — dead-code detection
- [**commitlint**](https://commitlint.js.org) + [**lefthook**](https://github.com/evilmartians/lefthook) — Conventional Commits + git hooks
- [**zod**](https://zod.dev) — argument validation
- [`@anthropic-ai/sdk`](https://www.npmjs.com/package/@anthropic-ai/sdk), [`openai`](https://www.npmjs.com/package/openai) — provider SDKs

## Project Layout

```
src/
  index.ts              # bin entry — parse argv, start REPL
  cli/                  # readline loop, slash commands, streaming renderer
  agent/                # loop, stream accumulator, tool execution, subagents
  tools/                # read, write, edit, grep, glob, bash, spawn_agent
  providers/            # anthropic + openai adapters, cost, retry, partial JSON
  security/             # path validation, secrets detection, command detection, permissions
  session/              # JSONL persistence, title generation
  config/               # tokenius.json, AGENTS.md, API key resolution
  skills/               # skill parser + discovery
docs/
  PLAN.md               # full architecture
  ROADMAP.md            # task checklist
  DECISIONS.md          # design rationale
```

## Design Decisions

Tokenius makes a handful of deliberate choices that a framework-based agent
would hide. The _why_ — with tradeoffs — is documented in
[`docs/DECISIONS.md`](./docs/DECISIONS.md). Highlights:

- No context compaction — sessions hard-stop at the context limit
- Anthropic-native canonical message format
- Sequential tool execution
- Append-only JSONL persistence
- Security wired into each tool, not a middleware layer
- Direct SDK usage — no LangChain, no AI SDK
- Bun-only runtime

## License

MIT — see [LICENSE](./LICENSE).
