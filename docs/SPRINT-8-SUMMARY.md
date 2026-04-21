# Sprint 8 Summary: Documentation & CI

**Status:** Complete (4/6 — 8.2 deferred to GitHub Settings, 8.5 dropped)
**Milestone:** Portfolio-ready. The repo has a pitch-shaped README, a CI workflow that runs every check the pre-commit hook does, a `package.json` that's ready to `bun add -g tokenius`, and a full design-decisions log. Anyone who clones can install, use, and understand _why_ the harness looks the way it does.

---

## What Was Built

Sprint 8 closes out the PLAN.md **CI/CD & Distribution** and **Documentation & Portfolio** sections. No new runtime code of note — the only `src/` change is a three-line polish in the bin entry point to make `--version` survive a global install. Everything else is docs, YAML, and `package.json`.

### Files Added

```
.github/
└── workflows/
    └── ci.yml                  # pinned Bun 1.3.0, concurrency group, full check + build
docs/
└── DECISIONS.md                # 10 entries (9 core + dropped /replay)
```

### Files Modified

```
README.md                       # full rewrite — pitch, install, architecture, tables, layout
package.json                    # bin, files, keywords, chmod in build, prepublishOnly
src/index.ts                    # #!/usr/bin/env bun shebang; static package.json import for --version
docs/ROADMAP.md                 # Sprint 8 progress tracked, 8.5 struck through
docs/PLAN.md                    # reconciled with actual package.json / build / bin shape
```

### Files Removed

None.

### Dependencies Added

None. Sprint 8 is a no-new-dependencies sprint by design.

---

## Architecture Decisions

### CI: pin Bun, cancel superseded runs, build as the last step

Three small but deliberate shapes in `.github/workflows/ci.yml`:

- **`bun-version: 1.3.0`** — pinned, not `latest`. A portfolio repo has to stay green; `latest` occasionally breaks CI for reasons unrelated to the change under review. Upgrading Bun becomes an explicit PR instead of an invisible regression.
- **`concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`** — a fast second push on the same branch cancels the in-flight run. Saves minutes of wasted compute and makes the "latest commit on main" status mean what it says.
- **A `Build` step at the end of the pipeline.** Tests and typecheck can pass while the bundler silently fails (broken `import` attributes, a regressed shebang, a bad JSON import). Building in CI catches those — the bin is only useful if the bundle still runs.

### `prepublishOnly` as the last line of defense

`prepublishOnly: bun run check && bun run build`. Runs lint, format:check, typecheck, knip, tests, and a fresh build immediately before `npm publish`. A broken release isn't a local problem; it's a "whoops, let me bump and republish" problem. The hook is cheap and final.

### Static `package.json` import, not `Bun.file`

Before Sprint 8, `src/index.ts --version` did this:

```ts
const pkg = (await Bun.file("package.json").json()) as { version: string };
```

That resolves `package.json` relative to `process.cwd()`. In dev it works because the repo root _is_ the cwd. After a global install (`bun add -g tokenius`) it's subtly broken: the binary is run from the user's project directory, where `package.json` is theirs, not ours. Worst case the user's `package.json.version` gets printed.

The fix:

```ts
import pkg from "../package.json" with { type: "json" };
// …
console.log(`tokenius v${pkg.version}`);
```

Bun's bundler inlines the JSON at build time. The bundled `dist/index.js` carries the version regardless of where it's run from. Works in dev (via direct execution) and in production (via the inlined string).

The same pattern will apply to any other metadata we want in the bin — bundling wins over runtime file reads for anything that ships as part of the distributable.

### Shebang + `chmod +x` is a two-part contract

Three things have to line up for a published bin to actually run:

1. `package.json.bin` points at the bundled file (`"tokenius": "./dist/index.js"`).
2. The bundled file starts with a shebang (`#!/usr/bin/env bun`). Bun's bundler preserves shebangs from the source entrypoint, so adding `#!/usr/bin/env bun` to `src/index.ts` propagates through `bun build`.
3. The bundled file is executable (`chmod +x`). npm and bun both preserve the execute bit when packing/installing, so the responsibility is on the _author_ to set it before `npm publish`.

The `build` script does steps 2 and 3 atomically:

```json
"build": "bun build src/index.ts --outdir dist --target bun && chmod +x dist/index.js"
```

Miss any of the three and the bin either isn't found, isn't runnable, or runs with the wrong interpreter. All three are needed.

### No `--minify` on the build

An earlier PLAN draft had `bun build ... --minify`. Dropped. The bundle is ~1.1 MB unminified, which is meaningless for a CLI installed once per machine. Minification costs stack-trace readability (every report from a crash becomes useless without a sourcemap) and a small amount of startup parse time. For a local tool, neither trade is worth it.

### README drops the progress table, keeps the architecture diagram

The old README had a sprint-by-sprint progress table. It aged badly — every landing shows a table that's slightly out of date until the next commit. The rewrite removes it in favor of a pointer to `docs/ROADMAP.md`, which is the actual source of truth.

The ASCII layer diagram stays. For a portfolio project, a diagram that fits on one screen and maps to the `src/` directory tree is worth more than any static prose.

### README structure: "what, how, why" in three passes

- **What** — one-line pitch, demo-shaped quickstart (prompts and slash commands a user might try), a tools/agents/commands table trio.
- **How** — the layer diagram and data-flow block show the architecture at two zoom levels. Each layer maps to a directory in the `src/` tree documented at the bottom.
- **Why** — every non-obvious choice links out to `docs/DECISIONS.md` (first, through the Design Principles summary, and then explicitly in a Design Decisions section with bullet-list highlights).

A reader who reads top-to-bottom gets the pitch first; a reader skimming for "does this do X?" lands on the right table; a reader asking "why did you build it this way?" has a one-click path to the log.

### `docs/DECISIONS.md` format: Status / Context / Decision / Alternatives / Rationale / Tradeoff / Consequences

Seven-section ADR-ish template. Two sections matter more than the rest:

- **Alternatives considered** — forces the entry to name what was rejected and why. A decision without named alternatives reads like an opinion; with them it reads like a choice.
- **Consequences** — the downstream effects on the codebase. Usually a short list of "because we decided X, file Y looks like Z." Makes the decisions grep-able from the code side: if you're reading `src/agent/execute.ts` and wondering why it's a plain `for … of`, the decision on sequential tool execution points at that file explicitly.

Ten entries total — the 9 decisions listed in PLAN.md:3044 plus the dropped `/replay` command. The final section ("Deferred, not decided") records MCP support, TUI layer, and multi-project skill discovery as known-open questions so "why isn't there X?" has an answer.

### Branch protection: deferred, not dropped

`8.2 Branch protection on main` is unchecked on the ROADMAP. The setting lives in GitHub's repo settings UI (or via `gh api repos/.../branches/main/protection`), not in code. It's also semi-destructive to enable silently — suddenly `git push` to main fails for the maintainer. The decision to enable it belongs with whoever owns the repo. Sprint 8 sets everything _else_ up (CI runs on PRs, checks are green) so the button is ready to flip when the owner is.

### Terminal demo: dropped

`8.5 Terminal demo recording` is struck through in both PLAN and ROADMAP. The reasoning matches the `/replay` drop from Sprint 7: sessions are already inspectable as plain JSONL (`cat ~/.tokenius/sessions/*.jsonl`), a vhs/asciinema capture requires a real API-keyed environment that can't be produced headlessly, and an elaborate demo earns its complexity only when paired with a richer TUI (Sprint 9 territory). The README's "Quick Start" block carries the demo load for now.

---

## Key Implementations

### `src/index.ts` — three-line bin-readiness patch

```ts
#!/usr/bin/env bun
// Entry point — thin bootstrap that turns CLI args into a running REPL.
// …

import pkg from "../package.json" with { type: "json" };

// …

if (args.version) {
  console.log(`tokenius v${pkg.version}`);
  return;
}
```

Shebang on line 1, JSON import at the top of the runtime code, version printed from the inlined string. That's the full surface of the src-side change this sprint.

### `package.json` — the distribution triangle

```jsonc
{
  "bin": { "tokenius": "./dist/index.js" },
  "files": ["dist", "README.md", "LICENSE"],
  "keywords": [
    "agent",
    "ai",
    "anthropic",
    "bun",
    "claude",
    "cli",
    "coding-agent",
    "coding-assistant",
    "llm",
    "openai",
  ],
  "scripts": {
    "build": "bun build src/index.ts --outdir dist --target bun && chmod +x dist/index.js",
    "prepublishOnly": "bun run check && bun run build",
  },
}
```

`files` whitelists what gets shipped to npm. `dist` is the bundle; the README and LICENSE give the npm page something to show. Everything else (`src/`, tests, docs, config) stays out of the tarball — users don't need them and they balloon the install size.

### `.github/workflows/ci.yml` — the full pipeline

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  check:
    name: Lint, format, typecheck, knip, tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.0 }
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run format:check
      - run: bun run typecheck
      - run: bun run knip
      - run: bun test
      - run: bun run build
```

Mirrors the local `lefthook` pre-commit hook exactly, with `bun run build` appended. Every step the contributor runs locally runs in CI too.

---

## Test Coverage

Sprint 8 ships no new tests. The suite still runs **367 pass / 3 skip / 0 fail** across 35 files. That's intentional — the work this sprint is on meta-layers (docs, CI, packaging) that aren't exercised by the unit suite. The CI workflow itself adds coverage at the integration level: any future PR that breaks the lint, format, typecheck, knip, tests, or build will fail in Actions.

The one useful new verification isn't a test — it's running the freshly-built bin:

```bash
bun run build
./dist/index.js --version
# → tokenius v0.1.0
```

Passes. With the prior `Bun.file("package.json")` code this call would have read the user's `package.json` at whatever cwd they ran from, which was the bug the static import fixes.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated to match the shipped code. Main reconciliations:

- **CI workflow gains a `concurrency` group and a final `Build` step.** PLAN had a minimal version without cancel-on-push and without a build-verification stage.
- **`bun-version` pinned to `1.3.0`.** PLAN had `latest`. Pinning is consistent with the rest of the repo's "explicit versions, no drift" stance and keeps CI stable.
- **`package.json` dropped `"private": true`.** Not strictly in PLAN's sketch, but worth recording here: the repo is now publish-ready.
- **`package.json.files` includes `README.md` and `LICENSE`.** PLAN had `["dist"]` only — workable, but then the npm page has no content and no license declaration.
- **`keywords` array is ten entries.** PLAN suggested five. Broader keyword coverage (`anthropic`, `claude`, `openai`, `bun` in addition to the generic ones) is friction-free and improves npm search discoverability.
- **Build script now does `bun build … --target bun && chmod +x dist/index.js`.** PLAN had `--minify` and no `chmod`. `--minify` dropped for readability of crash reports; `chmod` added because npm/bun preserve the execute bit from the source file, so the build has to set it.
- **`prepublishOnly` script added.** Not in PLAN at all. Cheap safety net that runs `check` + `build` right before `npm publish` rejects a broken release.
- **Shebang on `src/index.ts`.** PLAN sketched the src file without `#!/usr/bin/env bun`. Necessary for a working bin; preserved through `bun build` automatically.
- **Version read via static import, not `Bun.file`.** PLAN had `(await Bun.file("package.json").json())`. That's cwd-relative and broken for a globally installed bin. Replaced with `import pkg from "../package.json" with { type: "json" }` so the bundler inlines the version at build time.
- **`docs/DECISIONS.md` is 10 entries, not 9.** PLAN said "all 9 design decision entries". The dropped `/replay` command earned its own entry — a decision _not_ to ship a feature is still a decision worth documenting.
- **README drops the progress table.** PLAN didn't specify either way. The rewrite treats the README as a landing page (pitch + demo + architecture) and delegates progress tracking to `docs/ROADMAP.md`, which is the single source of truth.
- **Sprint 8 table updates.** `8.2` and `8.5` are annotated as deferred / dropped in both PLAN.md (with `~~8.5~~` strikethrough) and ROADMAP.md.

---

## Running It

```bash
# Install, build, confirm the bin works
bun install
bun run build
./dist/index.js --version                 # tokenius v0.1.0
./dist/index.js --help                    # HELP_TEXT from commands.ts

# Link it globally and use the command
bun link
tokenius                                  # starts the REPL

# The full check suite (lint, format, typecheck, knip, tests)
bun run check

# What CI runs (exactly — same commands, in order)
bun run lint && bun run format:check && bun run typecheck \
  && bun run knip && bun test && bun run build
```

**Sprint 8 done.** The repo has a CI pipeline that mirrors the pre-commit hook, a `package.json` that's ready to publish, a `src/index.ts` that survives a global install, a README shaped like a portfolio landing page, and a decisions log that names every non-obvious choice. Sprint 9 is TUI territory — spinners, syntax highlighting, permission dialogs — whenever that gets picked up.
