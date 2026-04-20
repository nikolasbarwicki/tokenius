# Sprint 2 Summary: Tools + Security

**Status:** Complete
**Milestone:** All 6 core tools work with security enforced. The harness can read files, search code, execute shell commands, and write/edit files — with path boundaries, secret detection, and dangerous-command gating wired into every relevant tool.

---

## What Was Built

Sprint 2 delivers **Layer 2 (Tool System)** and **Layer 5 (Security)** from the plan. The provider layer from Sprint 1 is now usable: an agent built on top of these pieces can actually _do things_ — the security-by-design rule from the design principles is enforced at the tool boundary, not bolted on later.

### Files Added

```
src/
├── security/
│   ├── path-validation.ts         # realpath-aware project boundary + blocked files/dirs
│   ├── secrets-detection.ts       # API key patterns + generic key/value heuristic
│   ├── command-detection.ts       # Two-tier gating: block + confirm
│   └── *.test.ts                  # Co-located tests
└── tools/
    ├── types.ts                   # JsonSchema, ToolDefinition, ToolContext, toToolSchema
    ├── registry.ts                # Deterministic schema sort for prompt caching
    ├── truncation.ts              # truncateHead / truncateTail with line-boundary snapping
    ├── validation.ts              # Hand-rolled JSON Schema validator (no AJV)
    ├── read.ts                    # Read with offset/limit, binary sniffing
    ├── write.ts                   # Create/overwrite with mkdir -p + secrets check
    ├── edit.ts                    # Exact-match replace with unique-or-replace_all semantics
    ├── bash.ts                    # Bun.spawn + composed AbortSignal (timeout + user abort)
    ├── grep.ts                    # Ripgrep wrapper (rg required, no manual fallback)
    ├── glob.ts                    # Bun.Glob with relative-path sanity check
    └── *.test.ts                  # Co-located tests
```

---

## Architecture Decisions

### Security by design, not bolted on

Each tool imports the security primitives directly: `read`/`write`/`edit`/`glob`/`grep` all call `validatePath()` as their first step, `write`/`edit` pass new content through `containsSecrets()`, and `bash` runs every command through `checkCommand()`. There's no "security middleware" to register, no way to forget. The harness can't ship with a tool that bypasses security by mistake — a code-level boundary, not a runtime one.

### Tightened `JsonSchema` type

The plan allowed `properties: Record<string, unknown>` as an escape hatch. The implementation restricts it to a discriminated union of primitives (`string` | `number` | `integer` | `boolean`) and single-type arrays, with optional `enum`/`minimum`/`maximum`. Benefits:

- The validator becomes ~90 lines of well-typed code — no AJV dependency, no schema language to learn.
- Tool authors can't sneak in unvalidated shapes. If a future tool genuinely needs nested objects, we extend the type deliberately.
- `typeof`-style exhaustive switching works end-to-end.

**Why this is the interesting bit:** coding-agent tools operate on untrusted LLM output. Every `string | null | undefined` you accept widens the attack surface. Starting with the narrowest usable schema is cheaper than tightening later.

### `ToolContext.confirm` hook (Sprint-3 seam)

The bash tool already knows how to ask for confirmation via `context.confirm?.(...)`. In Sprint 2 it defaults to always-allow when undefined — the hook exists, it's just not wired to a UI yet. Sprint 3 plugs in a real user prompt without touching the tool implementations.

### `truncateHead` vs `truncateTail`

File reads and search results get `truncateHead` (the relevant content is usually at the top). Bash output gets `truncateTail` (errors land at the bottom). Both enforce `MAX_LINES = 2000` _and_ `MAX_BYTES = 50_000`, and both snap to line boundaries so the LLM never sees a dangling half-line. The truncation notice tells the LLM exactly what it's missing and suggests the right next action (`offset`/`limit` or a narrower `grep`).

### Path canonicalization via `realpath`

The naïve containment check — `target.startsWith(cwd)` — breaks on macOS because `/tmp` is a symlink to `/private/tmp`. We use `realpathSync` on both sides before comparing, falling back to best-effort resolution for non-existent paths (needed so `write` can create new files). Containment is then checked via `path.relative` and rejecting `..` or absolute results, which is more robust than string prefix matching.

### Hand-rolled validator over AJV

With the restricted `JsonSchema` type, validation is small enough to own outright. The validator returns structured errors that the LLM can parse — e.g. `"path" must be string (got number)` — so a tool call with a bad shape becomes an error ToolResult, the loop continues, and the LLM retries with corrected arguments.

---

## Key Implementations

### Tool Registry — deterministic sort

Anthropic prompt caching hashes the exact prefix of the request. If we emit tool schemas in `Map` insertion order, inserting a tool later in the session invalidates every previous cache entry. `getToolSchemas` does a `.toSorted()` on the allowed names before mapping — deterministic for the life of the process, regardless of registration order.

### `edit` tool — unique-match semantics

`old_string` must either match exactly once, or `replace_all: true` must be set. Ambiguous matches fail with a message asking the LLM to add more surrounding context. This makes the tool self-correcting: the LLM reads the file, copies the exact text, and the edit either succeeds or tells it precisely what went wrong. Empty `old_string` and no-op edits (`old === new`) are errors — both are usually signs the model got confused.

### `bash` tool — composed abort signals

Two things can stop a running command: the user hitting Ctrl+C (external `AbortSignal` from the agent loop) and our internal timeout. `AbortSignal.any([external, internalTimeout])` fuses them into one signal we hand to `Bun.spawn`. After the process exits, we inspect the individual signals to produce the right error message (`aborted by user` vs `timed out after Nms`).

### `grep` — ripgrep required, no manual fallback

The plan called for a fallback "manual grep" if `rg` isn't installed. I deliberately dropped that. A fallback would be ~100 lines of worse code — no line numbers, no glob filtering, O(n) where rg is effectively O(indexed). Instead, a missing `rg` returns a clear install hint: `brew install ripgrep`. This is the better kind of dependency: a single optional binary with a well-known install command, detected lazily (cached after first check).

### `glob` — relative-path sanity check

`Bun.Glob.scan` shouldn't return paths outside the search root, but we check anyway — compute the `relative()` path and drop anything that starts with `..`. Belt-and-suspenders defense against symlinks or future `Bun.Glob` semantics changes. Dotfiles are excluded by default (pass `dot: true` to include).

### Secrets detection — labels, not booleans

`containsSecrets` returns `{ found: boolean; labels: string[] }` rather than just `true`/`false`. When the `write` tool blocks, it reports _which_ kind of secret was detected — "Anthropic API key", "potential credential assignment" — so the LLM knows exactly what to replace with an env var reference. The generic key/value heuristic is guarded against placeholder values (`YOUR_API_KEY`, `CHANGEME`) so real docs don't trip it.

### Command detection — two-tier gating

- **BLOCKED** (`allowed: false`): rm targeting `/`, mkfs, `dd` to devices, curl/wget piped to shell, fork bomb. Never runs, no override.
- **CONFIRM** (`requiresConfirmation: true`): recursive `rm`, `git reset --hard`, force push, `git branch -D`, SQL drops, `chmod 777`, `sudo`. Legitimate but destructive — defers to `ToolContext.confirm`.

The regexes are careful about shell quoting/piping edges (e.g. `\bgit\s+push\s+[^&|;]*--force\b` won't match `echo "--force"`), though this is heuristic, not sound parsing. The blocklist is the safety floor; the confirm tier is the UX.

---

## Test Coverage

**127 pass, 3 skip, 0 fail** across 17 test files. Highlights:

| Module              | What's covered                                                                  |
| ------------------- | ------------------------------------------------------------------------------- |
| `truncation`        | Under limits, MAX_LINES cap, MAX_BYTES cap, never cuts mid-line, tail variant   |
| `validation`        | Required keys, wrong types, enum, min/max, unknown props ignored, array items   |
| `path-validation`   | Within cwd, outside cwd, blocked files, blocked segments, realpath on /tmp      |
| `secrets-detection` | Anthropic/OpenAI/GitHub/AWS keys, generic kv, placeholder false-positive guard  |
| `command-detection` | Safe commands, each BLOCKED pattern, each CONFIRM pattern, tricky edges         |
| `read`              | Normal read, offset/limit paging, binary file sniffing, blocked path            |
| `grep`              | Pattern match, include filter, files_only, rg not installed                     |
| `glob`              | Pattern match, sorted output, dot files off by default, symlink escape guard    |
| `bash`              | Success, non-zero exit, timeout kill, blocked command, confirm hook integration |
| `write`             | Create, overwrite, mkdir -p, secret rejected                                    |
| `edit`              | Unique match, no match, multi-match fails, replace_all, empty old_string        |
| `registry`          | Deterministic sort regardless of registration order                             |

The skipped tests are marked for Sprint 3 wiring (confirmation prompt UI, abort signal end-to-end).

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated to reflect the implementation choices that diverged from the original plan:

- **`JsonSchema`** tightened to primitives + single-type arrays (no `Record<string, unknown>` escape hatch).
- **`ToolContext.confirm`** hook added for Sprint-3 permission wiring.
- **`bash.timeout_ms`** (was `timeout`) with a 600s max cap.
- **`grep`** added `ignore_case`, `files_only`; requires `rg` (no manual fallback).
- **`glob`** added `dot` param.
- **`validatePath`** canonicalizes via `realpathSync` to handle macOS symlink divergence.
- **Secrets patterns** added `sk-proj-`, `gho_`, and a placeholder-value guard.
- **Command patterns** added fork bomb, wget-pipe, `git branch -D`.

---

## How It Connects to Sprint 3

Sprint 3 (Agent Loop) consumes everything from Sprints 1 and 2:

- **Stream accumulator** uses provider `StreamEvent`s and the `parsePartialJson` recovery path.
- **Tool execution** iterates validated calls, calls `tool.execute`, applies `truncateHead`/`truncateTail`.
- **Permission prompts** wire `promptPermissions()` into `ToolContext.confirm` — the seam is already in place in the `bash` tool.
- **`spawn_agent`** is the first tool that doesn't exist at the Sprint 2 boundary; it needs the agent loop itself.

The Sprint 2 surface is deliberately passive — tools don't know about agents, agents don't exist yet. Sprint 3 is where the loop wires the stream, tools, and security together.

---

## Running It

```bash
# All tests
bun test

# Full check suite (lint, format, typecheck, knip, test)
bun run check

# Smoke test the provider layer (needs ANTHROPIC_API_KEY)
bun run src/smoke.ts
```

No CLI entry point for tools yet — that's Sprint 6. Sprint 3 adds an end-to-end test that wires the provider + tools + security through a mock agent loop.
