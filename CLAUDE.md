Tokenius is a personal coding agent (harness) built from scratch in TypeScript + Bun. Fat skills, thin harness. Single-process, streaming-first, no framework abstractions. This is an educational/portfolio project — the goal is to deeply understand how coding agents work by building one from the ground up.

Key principles:

- **One loop, many agents** — agents are configurations (system prompt + tool set + constraints), not code.
- **Tools are the API** — everything the LLM does goes through a tool. No special-cased behavior.
- **Security by design** — path validation, command gating, secrets detection built into each tool as it's created.
- **Streaming-first** — every LLM interaction is a stream. No batch-then-display.
- **Direct SDK usage** — no LangChain, no AI SDK. Anthropic and OpenAI SDKs directly.

## Setup & Commands

- `bun install` — install dependencies (Bun auto-loads `.env`, no dotenv)
- `bun run dev` — start with watch mode
- `bun run build` — bundle to `dist/`
- `bun run check` — run all checks (lint, format, typecheck, knip, tests)
- `bun test` — run tests (test files live next to source as `*.test.ts`)

## Git Workflow

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (enforced by commitlint)
- Pre-commit hook runs: lint, format, typecheck, tests, knip

## Conventions

Add dependencies only with justification — the template is intentionally minimal.

- TypeScript style rules: [docs/agents/TYPESCRIPT.md](./docs/agents/TYPESCRIPT.md)
- Preferred Bun APIs over third-party packages: [docs/agents/BUN_APIS.md](./docs/agents/BUN_APIS.md)

## Working Style

- Check [docs/ROADMAP.md](./docs/ROADMAP.md) for current progress before starting work.
- When completing a roadmap task, mark its checkbox in ROADMAP.md.
- Implement one task at a time. Run `bun run check` after each to verify nothing breaks.
- Read the relevant section of [docs/PLAN.md](./docs/PLAN.md) before implementing a layer — it contains full type definitions, code sketches, and edge cases.

## Teaching Mode

This is a learning project. I'm building this to deeply understand how coding agents work.

- **Explain before implementing.** Before writing code, briefly explain _why_ this approach — what tradeoff we're making, what alternatives exist, and why this one wins. Keep it concise (a few sentences, not essays).
- **Ask me decision questions.** When the architecture doc leaves room for interpretation or when there are meaningful implementation choices, ask me what I'd prefer and explain the options. Don't silently pick defaults.
- **Flag "interesting bits."** When implementing something that teaches a transferable concept (streaming patterns, partial parsing, security boundaries), call it out. A one-liner like "This is the core insight behind X" goes a long way.
- **Challenge my understanding.** If I suggest an approach that has a non-obvious problem, explain the issue rather than silently fixing it. I want to learn from mistakes, not have them hidden.
- **Connect to the bigger picture.** When building a piece, briefly note how it fits into the overall architecture — what depends on it, what it depends on.
