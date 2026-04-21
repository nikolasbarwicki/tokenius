# Design Decisions

This is the _why_ log. Every non-obvious architectural choice in Tokenius is
recorded here with its alternatives, rationale, and the tradeoff it locks in.
Decisions stay in this document even after they're superseded — the history
matters more than the current state.

Each entry follows the same shape:

- **Status** — `Accepted`, `Superseded`, or `Rejected`.
- **Context** — the forces at play when the decision was made.
- **Decision** — the choice, stated in a sentence.
- **Alternatives considered** — what we said no to, and why.
- **Rationale** — the reasoning, in detail.
- **Tradeoff** — what this buys and what it costs.
- **Consequences** — knock-on effects for the rest of the system.

---

## Table of Contents

1. [No context compaction](#1-no-context-compaction)
2. [Anthropic-native canonical message format](#2-anthropic-native-canonical-message-format)
3. [Sequential tool execution](#3-sequential-tool-execution)
4. [JSONL session persistence](#4-jsonl-session-persistence)
5. [No plugin system for tools](#5-no-plugin-system-for-tools)
6. [Security wired into each tool](#6-security-wired-into-each-tool)
7. [Direct SDK usage (no LangChain, no AI SDK)](#7-direct-sdk-usage-no-langchain-no-ai-sdk)
8. [Hard-coded model metadata](#8-hard-coded-model-metadata)
9. [Bun-only runtime](#9-bun-only-runtime)
10. [`/replay` command — dropped](#10-replay-command--dropped)

---

## 1. No context compaction

**Status:** Accepted.

**Context.** Every coding agent eventually hits its context window. Once the
sum of `system prompt + tool schemas + conversation history + AGENTS.md`
exceeds the model's limit, the next request fails. Mature agents (Claude
Code, Cursor, Aider) mitigate this by _compacting_: they feed older messages
to a cheap model, replace them with a summary, and continue. That preserves
the illusion of a single long-running session.

**Decision.** Tokenius does not compact. When the context tracker estimates
that the next turn would exceed the model's window, the loop terminates with
a clear message. The user either starts a fresh session (`/clear`) or loads
an earlier one (`/load <id>`).

**Alternatives considered.**

- _LLM-summary compaction._ Pick a cut-point, summarize everything before it
  with Haiku or GPT-4o-mini, splice the summary in place of the originals.
  Works, but needs a cut-point heuristic (which messages to keep verbatim?
  how much budget for the summary?) and introduces a second model dependency
  plus a new cost-tracking path.
- _Sliding window._ Drop the oldest N messages until the window fits. Cheaper
  but even lossier — the model silently loses prior tool results and early
  user intent.
- _File-based memory._ Encourage the agent to write long-term notes to disk
  and re-read them. Works best with a richer memory skill and didn't fit the
  scope of a portfolio build.

**Rationale.**

- For a learning project, simplicity beats a marginal UX improvement. The
  whole point of building a harness from scratch is to make every piece
  legible; compaction is a non-trivial feature that obscures how the context
  is actually assembled.
- Compaction hides model failure modes behind a lossy summary. If the model
  forgets a constraint because its summary elided it, that's a bug you can't
  diagnose without reading the summary prompt.
- 200k tokens is roughly 150k words. Most coding sessions comfortably fit.
  Sessions that don't probably _should_ have been scoped smaller.
- The session-persistence design already lets the user resume a prior
  session, so "start fresh" isn't the same as "lose your work."

**Tradeoff.** Long, sprawling sessions (multi-file refactors across dozens of
files) hit the wall. The user must learn to work in scoped sessions — start
a new one per task.

**Consequences.**

- `src/agent/context-tracker.ts` is tiny — no compaction policy, no summary
  prompt, no cut-point heuristic.
- The `/clear` slash command is a primary workflow, not an edge case.
- Session persistence matters more: resuming a prior session is how you
  "continue" a large effort.

---

## 2. Anthropic-native canonical message format

**Status:** Accepted.

**Context.** Every provider has a different wire format for assistant
messages, tool calls, and streaming events. OpenAI emits `tool_calls` as a
sibling array on the message; Anthropic models tool calls as typed content
blocks (alongside text and thinking blocks). Gemini has its own shape. An
internal representation has to choose one — or invent a third.

**Decision.** The internal `Message` type mirrors Anthropic's format:
assistant messages carry an ordered `content` array of typed blocks (`text`,
`thinking`, `tool_call`). The OpenAI provider reshapes on the way in and on
the way out.

**Alternatives considered.**

- _OpenAI-native canonical._ Popular and simpler on the surface, but it can't
  represent thinking blocks or interleaved text-and-tool-call content
  without extensions, and those are first-class concepts for Claude.
- _Bespoke intermediate format._ Decouples us from any one vendor, but costs
  two conversions per turn instead of one, and reinvents a shape for a
  problem that already has a good answer.

**Rationale.**

- Anthropic's format is the strict superset. Text blocks, thinking blocks,
  and tool-call blocks all compose naturally into a single `content` array.
  Downgrading from this to OpenAI's flat string + tool-calls pair is
  straightforward; upgrading the other direction silently loses thinking
  blocks.
- The same OpenAI adapter works unchanged for any OpenAI-compatible service
  (xAI, DeepSeek, GLM, Kimi, Groq, local llama.cpp). Effectively, two
  converters cover the entire market today; a future Gemini adapter would be
  a third.
- Streaming maps cleanly: Anthropic's `content_block_start` / `_delta` /
  `_stop` event trio aligns with the content-block model we already use.

**Tradeoff.** We're coupled to Anthropic's shape. If Anthropic ever
introduces a non-superset change, we absorb it; OpenAI-native code would
not. In practice the risk is low — Anthropic has been additive, not
subtractive.

**Consequences.**

- Thinking blocks exist as first-class entities throughout the codebase
  (`src/providers/types.ts`).
- The OpenAI path intentionally drops thinking blocks on the response side —
  the OpenAI chat-completions API has nowhere to put them.
- Cost tracking separates cache-read and cache-write tokens because
  Anthropic exposes them distinctly; the OpenAI adapter fills zero for those
  fields.

---

## 3. Sequential tool execution

**Status:** Accepted.

**Context.** A single assistant turn can contain multiple tool calls. The
loop has to run each one, collect its result, and feed everything back to
the model. Nothing in the protocol requires them to run one at a time.

**Decision.** Tool calls are executed strictly sequentially in the order the
model emitted them.

**Alternatives considered.**

- _Parallel execution._ `Promise.all` the calls. Faster, but creates
  opportunities for race conditions (two `edit`s on the same file, a `bash
rm` concurrent with a `read`, a `write` that depends on the output of a
  prior `read`).
- _Dependency-aware parallelism._ Analyze arguments to detect conflicts and
  parallelize only when safe. Clever and expensive — a plan-and-schedule
  layer on top of each turn.

**Rationale.**

- Coding tool calls are _state-modifying_. Two edits to the same file can
  race. A `write` followed by a `read` assumes ordering. A `bash` that
  launches a dev server expects the next tool call to see the new port.
  Parallel execution requires reasoning about every pair's commutativity,
  which is almost always more expensive than just running them in order.
- Permission prompting is simpler: we batch all pending prompts at the start
  of the batch, collect yes/no/always, and then execute. With parallelism we
  either lose the batching or have to synchronize before each call.
- The user-visible latency is dominated by the model's streaming latency,
  not by tool execution. Most tools return in < 100ms. Parallelism is
  saving milliseconds against a budget measured in seconds.

**Tradeoff.** A turn with, say, three independent `read`s runs ~3x slower
than it could. In practice that's 50–150ms — below the perceptible
threshold for a terminal user who is already watching a streaming response.

**Consequences.**

- `src/agent/execute.ts` is a plain `for … of` loop.
- Tool outputs are appended to messages in deterministic order, so session
  JSONL replays identically.

---

## 4. JSONL session persistence

**Status:** Accepted.

**Context.** Sessions need to persist for three reasons: resumability
(`/load`), observability (`cat`, `jq`), and cost accounting (`/cost`,
`/usage`). Options span a spectrum from SQLite to plain-text dumps.

**Decision.** Each session is a JSON-Lines file at
`~/.tokenius/sessions/<uuid>.jsonl`. Every message is a single line. Writes
are append-only.

**Alternatives considered.**

- _SQLite._ Queryable, structured, atomic. But every session lookup becomes
  a query, and inspecting a session requires a client.
- _One JSON file per session._ Simpler to read into memory, but rewriting
  the whole file on every append is O(n²) over a long session and makes
  crash recovery messier.
- _Protobuf / MessagePack._ Smaller on disk, unreadable without tooling. The
  size win is meaningless — sessions are kilobytes, not megabytes.

**Rationale.**

- JSONL is the minimal format that satisfies every requirement. `cat
session.jsonl` shows you the session; `jq` turns it into any view you
  want; `tail -f` watches it live.
- Append-only writes are crash-safe. If the process dies mid-turn, at worst
  the last line is truncated — the rest of the file is valid and loadable.
- Every line is self-contained, so streaming an in-progress write to disk
  doesn't risk corruption.
- No migrations. If the `Message` shape evolves, we add a `schemaVersion`
  field to each line or do ad-hoc parsing. No ALTER TABLE.

**Tradeoff.** No native querying. "Find every session that used > $1" is a
shell loop, not a SQL query. For the scale this agent operates at (tens or
hundreds of sessions on a user's machine), that's fine; if it ever hits
thousands, build an index on top.

**Consequences.**

- `src/session/manager.ts` is a thin wrapper over `Bun.file().writer()`.
- The first-run `.gitignore` hint matters: `~/.tokenius/` is user-global
  but the agent also writes relative-path artifacts, and project-checked-in
  sessions would leak secrets.

---

## 5. No plugin system for tools

**Status:** Accepted.

**Context.** Every tool-using agent eventually grows a plugin story: users
want to add a `browser`, a `sql`, an `http` tool, and so on. The convention
is to define a plugin interface, provide registration hooks, and let users
drop code into a `plugins/` directory.

**Decision.** Tokenius has a fixed, in-tree set of tools. There is no plugin
loader, no dynamic registration, no external tool API.

**Alternatives considered.**

- _File-based plugin directory._ Scan `~/.tokenius/tools/`, dynamic-import
  each file, register the exports. Requires a stable public API, sandboxing
  story, and security review at load time.
- _MCP integration._ Wire up the Model Context Protocol so any MCP server
  can expose tools. Real option; deferred, not rejected.
- _Config-declared HTTP tools._ Let users declare tools in `tokenius.json`
  as `{ name, endpoint, schema }`. Useful but opens a large auth/security
  surface.

**Rationale.**

- The current 7 tools (read, write, edit, grep, glob, bash, spawn_agent) are
  sufficient for coding work. `bash` is the escape hatch for anything they
  don't cover.
- A plugin API is a commitment. Every public change breaks every plugin.
  Without a real userbase demanding it, a plugin system is speculative
  design.
- Security boundaries inside the harness (path validation, secrets
  detection, command detection) are wired per-tool. A plugin would bypass
  those guarantees unless the plugin API formalized them, which is a
  significant design effort.

**Tradeoff.** Adding a new capability means editing the repo. That's a
feature, not a bug, for a portfolio project — every tool is visible and
reviewable. It's a limitation for a real-world agent that users want to
extend without contributing upstream.

**Consequences.**

- `src/tools/registry.ts` is a plain `Record` of tool instances.
- If MCP support is added later, it enters through a single `mcp` tool that
  dispatches to discovered MCP servers — a bounded integration point, not a
  general-purpose loader.

---

## 6. Security wired into each tool

**Status:** Accepted.

**Context.** Coding agents have three well-known failure modes: writing
secrets to disk, running destructive shell commands, and escaping the
project root via path traversal. The standard mitigation is a middleware
layer — a "sandbox" that every tool call passes through.

**Decision.** Each tool owns its own security checks inline. `read`, `write`,
and `edit` call `validatePath` before touching the filesystem. `write` and
`edit` scan their payloads for secrets. `bash` classifies its command
against an allow/block/confirm matrix before spawning.

**Alternatives considered.**

- _Middleware / interceptor layer._ A wrapper function that runs before every
  tool, consulting a central policy. Elegant on paper; brittle in practice
  because different tools need different checks (there's no single "is this
  arg safe?" question — `write`'s content must be scanned; `grep`'s pattern
  must not be).
- _Runtime sandbox._ OS-level isolation (seccomp, bubblewrap, Docker). The
  right answer at scale; overkill for a local coding agent and doesn't work
  cross-platform without significant engineering.
- _Trust the model._ What every agent does by default. Works until it
  doesn't.

**Rationale.**

- Security is a property of the operation, not a layer on top. The path
  check makes sense only for file tools; the secrets scan makes sense only
  for writes; the command classifier makes sense only for `bash`. A
  middleware ends up with conditional logic per tool anyway — might as well
  colocate the logic with the tool.
- Inline checks are easier to test. Each tool's test suite owns its own
  security tests. There's no separate "security middleware" test that can
  drift from the tools it protects.
- Wiring security during tool construction (Sprint 2, alongside each tool)
  prevents the common "we'll bolt on permissions later" failure mode.

**Tradeoff.** The same code patterns appear in multiple tools (e.g., every
file tool calls `validatePath`). The duplication is shallow — shared helpers
in `src/security/` do the actual work — but a future reader has to grep
across tools to enumerate "all the security checks."

**Consequences.**

- `src/security/` holds the reusable checks; each tool calls them
  explicitly.
- New tools added in the future must add their own checks — there's no
  automatic protection. The tool-checklist in the roadmap is intentional.
- Permission prompts are batched at the loop level (`src/security/permissions.ts`),
  not inside each tool, because batching requires awareness of the whole
  pending batch.

---

## 7. Direct SDK usage (no LangChain, no AI SDK)

**Status:** Accepted.

**Context.** The JavaScript ecosystem offers at least three popular
abstractions for building agents: LangChain.js, Vercel's AI SDK, and Mastra.
Each claims to save you from dealing with the differences between providers.

**Decision.** Tokenius calls `@anthropic-ai/sdk` and `openai` directly. There
is no agent framework, no LLM abstraction library, no prompt template
library.

**Alternatives considered.**

- _LangChain._ Huge surface area, heavy abstraction tax, a reputation for
  breaking changes. Good for prototyping; fights you when you want control.
- _Vercel AI SDK._ Slimmer than LangChain, opinionated toward edge-function
  streaming. Would force us to adopt its message shape and tool-calling
  protocol — a provider abstraction on top of our provider abstraction.
- _Custom "router" with a shared interface, then wrap each SDK._ Exactly
  what the `Provider` interface in `src/providers/types.ts` already does —
  just without the extra package.

**Rationale.**

- The goal of this project is to _understand_ how coding agents work. Every
  abstraction is an opportunity for the implementation to become opaque.
  Reading `src/providers/anthropic.ts` top-to-bottom teaches you the
  Anthropic streaming protocol; reading LangChain's Anthropic adapter
  teaches you LangChain.
- Provider SDKs are already well-designed. The abstraction they need on top
  is small — a single `stream()` method returning our canonical event
  stream. Writing that adapter is ~300 lines per provider, most of which is
  mapping wire events to our canonical `StreamEvent` type.
- Every extra dependency is a future vulnerability, a future breaking
  change, and a future "why did you pick this library?" question.

**Tradeoff.** If Anthropic or OpenAI ships a new feature, we integrate it
ourselves. Frameworks often ship adapters within days; we don't. For a
personal tool that's a minor cost.

**Consequences.**

- `package.json`'s `dependencies` is short and every entry is justified.
- Adding a Gemini provider means writing a third 300-line adapter, not
  finding the right plugin.
- The code is legible to a new reader without onboarding into a framework's
  mental model.

---

## 8. Hard-coded model metadata

**Status:** Accepted.

**Context.** The agent needs per-model metadata: context window size, input
price, output price, cache pricing. This data lives on provider websites and
occasionally in APIs (Anthropic and OpenAI both have `/models` endpoints, of
varying completeness).

**Decision.** Model metadata lives in a static table in
`src/providers/models.ts`. Unknown models fall back to a permissive default
and surface a warning in debug mode.

**Alternatives considered.**

- _Query the provider's `/models` endpoint at startup._ Auto-discovery;
  no manual updates. But the data is incomplete (pricing isn't always
  there), adds a blocking network call to boot, and fails offline.
- _Fetch and cache periodically._ The hybrid. Adds a cache invalidation
  story and a staleness window.
- _Read from a config file the user maintains._ Shifts the burden to the
  user for zero benefit.

**Rationale.**

- Model metadata changes on the order of months, not hours. A new Claude
  model lands every 3–6 months; pricing changes are rarer. Pinning the data
  in source is more truthful than pretending it's dynamic.
- Pricing isn't in the provider APIs reliably. Anthropic's `/models`
  endpoint doesn't return per-million-token prices. OpenAI's doesn't either.
  Auto-discovery solves the easy part (names) and not the hard part
  (prices).
- Tokenius pins a specific Bun version and explicit provider SDK versions.
  Hard-coding model metadata is consistent with that stance: this is a
  deliberate-versioning project.

**Tradeoff.** When Anthropic ships a new model, the table has to be updated
by hand. Using an unknown model still works (it falls back to the default
window and zero cost), but cost tracking goes stale until the next release.

**Consequences.**

- `src/providers/models.ts` is the single source of truth for model capabilities
  and pricing — easy to audit, easy to PR.
- The context tracker and cost calculator both consult this table; neither
  does any I/O.
- `/cost` is accurate _because_ the table is maintained; an auto-discovery
  approach would tend to degrade silently when fields are missing.

---

## 9. Bun-only runtime

**Status:** Accepted.

**Context.** TypeScript agents can target Node.js (ubiquitous, mature), Deno
(TypeScript-native, sandboxed), or Bun (fast, batteries-included, TypeScript
native). Each picks different defaults for modules, testing, bundling, and
I/O.

**Decision.** Tokenius requires Bun 1.3+. There is no Node.js compatibility
shim, no Deno compatibility, no fallback.

**Alternatives considered.**

- _Node.js with tsx or similar._ Maximum portability. Requires a bundler, a
  test runner, a dotenv package, and a build toolchain that Bun provides
  out of the box.
- _Deno._ TypeScript-native, sandboxed, URL-based imports. Smaller ecosystem
  and conspicuous module-resolution differences from npm expectations.
- _Dual-target (Node + Bun)._ Support both. Doubles the surface area; every
  file-I/O call, every subprocess spawn, every env-var lookup has to work
  on both.

**Rationale.**

- Bun replaces four tools at once: runtime, test runner, bundler, package
  manager. `bun test`, `bun build`, `bun install` are all native and fast.
  That alignment is worth a lot in a small codebase.
- Bun's native APIs (`Bun.file`, `Bun.Glob`, `Bun.spawn`) are better-designed
  than their Node.js equivalents and remove the need for `fs/promises`,
  `glob` the package, `child_process`, etc.
- Bun auto-loads `.env` — no `dotenv` package, no boilerplate in the
  entrypoint.
- `.tsx` is a first-class extension; there's no build step during
  development. Edit, run, see results.

**Tradeoff.** Users who don't have Bun installed have to install it before
they can run Tokenius. It's a one-line install (`curl -fsSL
https://bun.sh/install | bash`) and Bun is widely adopted, but it's still a
friction point compared to "if you have Node, you can run it."

**Consequences.**

- The bin script uses `#!/usr/bin/env bun` rather than `node`.
- `Bun.Glob` and `Bun.file` appear throughout the codebase; a future port to
  Node would mean replacing them.
- The knip config, lefthook hooks, and CI workflow are all Bun-first.

---

## 10. `/replay` command — dropped

**Status:** Rejected (originally planned for Sprint 7).

**Context.** The original Sprint 7 plan included a `/replay <session-id>`
command: stream a saved session's messages with a fake per-character delay,
skipping tool execution and API calls. The goal was to make demos easier and
give users a way to re-view long sessions.

**Decision.** The command was cut before implementation.

**Alternatives considered.**

- _Implement as planned._ A small accumulator, a `setTimeout`-driven fake
  stream, a flag to skip tool side effects.
- _Pretty-print only._ Reformat a session JSONL into a human-readable form
  for reading, without the streaming simulation.
- _Integrate into a future TUI._ Collapsible tool blocks, syntax
  highlighting, scroll-through — the replay experience is much richer when
  paired with a TUI.

**Rationale.**

- Sessions are already inspectable on disk. `cat ~/.tokenius/sessions/*.jsonl`
  or `jq` gives you everything a replay would show without the fake
  streaming theater.
- The pretty-printed variant earns its complexity only when paired with
  visual affordances (syntax highlighting, collapsible blocks) that don't
  exist in the current CLI.
- No other feature depends on replay. It was a demo aid, and demo aids
  shouldn't ship as first-class features.

**Tradeoff.** There's no built-in way to re-watch a long streaming session.
Users who want that experience will wait for the TUI sprint.

**Consequences.**

- `src/cli/commands.ts` ships without `/replay`.
- The decision is recorded here (and in
  [`docs/PLAN.md`](./PLAN.md#replay-command--dropped)) so the absence is
  documented, not mysterious.

---

## Deferred, not decided

These came up during design and remain open. They are not decisions because
no implementation has committed to either side.

- **MCP support.** Whether, and how, to integrate the Model Context Protocol
  for external tool servers. Probably desirable eventually; not scoped.
- **A TUI layer.** Sprint 9 placeholder. The choice of Ink vs. a custom
  renderer is still open.
- **Multi-project skill discovery.** Currently skills live under
  `.tokenius/skills/` in the project root. A global
  `~/.tokenius/skills/` location is plausible but not implemented.
