# Tokenius

A lightweight, well-designed coding agent harness. Single-process TypeScript + Bun.

## Architecture

Tokenius is a layered system with a streaming-first, tool-centric design:

```
CLI / TUI Interface
Configuration & Project Rules
Skills
Session Persistence
Security
Agents & Subagents
Agent Loop
Tool System
LLM Provider Abstraction
```

Key design principles:

- **One loop, many agents** — the agent loop is a single function. Agents are configurations, not code.
- **Tools are the API** — everything the LLM does goes through a tool.
- **Streaming-first** — every LLM interaction is a stream.
- **Security by default** — path validation, command gating, secret protection are built in.
- **Direct SDK usage** — no Langchain, no AI SDK, no abstractions over abstractions.

See [docs/architecture-v2.md](./docs/architecture-v2.md) for the full technical architecture.

## Tech Stack

- **Runtime / Package Manager / Test Runner / Bundler:** [Bun](https://bun.sh)
- **Language:** TypeScript (strictest settings)
- **Linter:** [oxlint](https://oxc.rs/docs/guide/usage/linter)
- **Formatter:** [oxfmt](https://oxc.rs/docs/guide/usage/formatter)
- **Dead Code:** [knip](https://knip.dev)
- **Commit Linting:** [commitlint](https://commitlint.js.org) (Conventional Commits)
- **Git Hooks:** [lefthook](https://github.com/evilmartians/lefthook)

## Progress

| Sprint | Focus                                                       | Status             |
| ------ | ----------------------------------------------------------- | ------------------ |
| 1      | Foundation — provider layer, streaming, cost tracking       | **Done** (9/9)     |
| 2      | Tools + Security — core tools, path/secret/command guards   | Not started (0/13) |
| 3      | Agent Loop — loop, context tracking, permissions, subagents | Not started (0/9)  |
| 4      | Persistence — session save/load                             | Not started (0/4)  |
| 5      | Config & Skills — config loader, AGENTS.md, skill system    | Not started (0/6)  |
| 6      | CLI — args, renderer, slash commands, bootstrap             | Not started (0/8)  |
| 7      | Polish — OpenAI provider, error handling, UX                | Not started (0/6)  |
| 8      | Docs & CI — GitHub Actions, README, demo                    | Not started (0/6)  |
| 9      | TUI (future) — rich terminal UI                             | Not started (0/5)  |

See [docs/ROADMAP.md](./docs/ROADMAP.md) for the detailed task checklist.

## Getting Started

```bash
bun install
```

## Scripts

| Command                | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `bun run dev`          | Start with watch mode                                 |
| `bun run build`        | Bundle to `dist/`                                     |
| `bun run lint`         | Lint with oxlint                                      |
| `bun run lint:fix`     | Lint and auto-fix                                     |
| `bun run format`       | Format with oxfmt                                     |
| `bun run format:check` | Check formatting without writing                      |
| `bun run typecheck`    | Type-check with `tsc --noEmit`                        |
| `bun run knip`         | Detect unused exports and dependencies                |
| `bun test`             | Run tests                                             |
| `bun run check`        | Run all checks (lint + format + types + knip + tests) |

## Git Hooks

Lefthook runs automatically on every commit:

**pre-commit** (parallel): lint, format check, typecheck, tests, knip

**commit-msg:** Enforces [Conventional Commits](https://www.conventionalcommits.org) via commitlint
