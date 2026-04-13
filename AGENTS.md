# AGENTS.md

Strict TypeScript starter built on Bun. Use Bun as the runtime, package manager, test runner, and bundler.

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

- TypeScript style rules:
  [docs/TYPESCRIPT.md](./docs/TYPESCRIPT.md)
- Preferred Bun APIs over third-party packages:
  [docs/BUN_APIS.md](./docs/BUN_APIS.md)
