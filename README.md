# bunbase 🧊

Strict TypeScript starter optimized for AI-assisted development. Every commit is validated by five parallel checks — linting, formatting, type checking, dead code detection, and tests — so agents (and humans) get instant feedback on every change.

## Tech Stack

- **Runtime / Package Manager / Test Runner / Bundler:** [Bun](https://bun.sh)
- **Language:** TypeScript (strictest settings)
- **Linter:** [oxlint](https://oxc.rs/docs/guide/usage/linter) — correctness, suspicious, pedantic, perf, style
- **Formatter:** [oxfmt](https://oxc.rs/docs/guide/usage/formatter) — with sorted imports
- **Dead Code:** [knip](https://knip.dev)
- **Commit Linting:** [commitlint](https://commitlint.js.org) (Conventional Commits)
- **Git Hooks:** [lefthook](https://github.com/evilmartians/lefthook)

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

**pre-commit** (parallel):

- `bun run lint`
- `bun run format:check`
- `bun run typecheck`
- `bun test`
- `bun run knip`

**commit-msg:**

- Enforces [Conventional Commits](https://www.conventionalcommits.org) via commitlint

## TypeScript Config

Maximum strictness enabled:

- `strict: true`
- `noUncheckedIndexedAccess` — indexed access returns `T | undefined`
- `exactOptionalPropertyTypes` — no implicit `undefined` in optional props
- `noImplicitReturns`, `noImplicitOverride`, `noFallthroughCasesInSwitch`
- Bundler module resolution with `verbatimModuleSyntax`

## Linter Highlights

- `no-explicit-any` is an **error**
- `consistent-type-imports` enforced (use `import type`)
- `no-default-export` warned (except config files)
- `no-cycle` and `no-self-import` prevent circular dependencies
- Plugins: typescript, unicorn, import, promise, oxc, node

## Formatter Config

- Print width: 100
- Double quotes, trailing commas, semicolons
- Automatic import sorting (builtin > external > internal > relative > type)

## Project Structure

```
.
├── src/
│   ├── index.ts          # Entrypoint
│   └── index.test.ts     # Tests
├── .oxlintrc.json        # Linter config
├── .oxfmtrc.json         # Formatter config
├── knip.json             # Dead code detection config
├── lefthook.yml          # Git hooks
├── commitlint.config.js  # Commit message rules
├── tsconfig.json         # TypeScript config
├── .editorconfig         # Editor settings
└── CLAUDE.md             # AI agent instructions
```

---

Built with [Yapper](https://yapper.to/) by [Nikolas](https://nbarwicki.com)
