# Sprint 7 Summary: Polish

**Status:** Complete (`/replay` deliberately dropped — see below)
**Milestone:** Production-quality CLI. Two providers (Anthropic + any OpenAI-compatible endpoint), actionable provider errors, detailed `/usage` view, ripgrep-optional `grep`, and a proper first-run landing page when the API key env var is missing. Every sharp edge from Sprint 6 has been filed off.

---

## What Was Built

Sprint 7 delivers the remaining tasks from **Layer 1 (OpenAI provider)**, **Layer 8 (first-run UX)**, and **Layer 9 Phase 1 polish (`/usage`, error handling)** in PLAN.md. No new abstractions — each feature slots into a layer that already existed.

### Files Added

```
src/
├── cli/
│   └── messages.ts                  # printBanner, printFirstRunHint, printMissingApiKey
└── providers/
    ├── openai.ts                    # chat completions (Anthropic-native ↔ flat conversion)
    └── openai.test.ts               # convertMessages, convertTools, mapChunks, normalizeStopReason
```

### Files Modified

```
src/
├── agent/
│   ├── loop.ts                      # streamTurnWithEmptyRetry helper; droppedUsage billed
│   └── loop.test.ts                 # + empty-retry, abort-between-retries, usage-billing tests
├── cli/
│   ├── commands.ts                  # /usage command + shared summarizeSession helper
│   ├── commands.test.ts             # /usage output assertions
│   └── index.ts                     # catches MissingApiKeyError, routes through messages.ts
├── config/
│   ├── api-keys.ts                  # MissingApiKeyError typed class
│   ├── api-keys.test.ts             # throws MissingApiKeyError on missing env var
│   ├── loader.ts                    # ConfigSchema picks up baseUrl for OpenAI-compatible hosts
│   └── loader.test.ts               # baseUrl accepted/rejected
├── providers/
│   ├── retry.ts                     # friendlyProviderError rewrites 401/403/404/400/429
│   └── retry.test.ts                # friendly-error table, cause preservation, passthrough
└── tools/
    ├── grep.ts                      # pure-Bun fallback walker when rg isn't on PATH
    └── grep.test.ts                 # rg-off path exercised via resetRipgrepCache
```

### Files Removed

None.

### Dependencies Added

- **`openai`** — official SDK, used directly. Same pattern as `@anthropic-ai/sdk` from Sprint 1. No AI-SDK abstraction in between. The conversion tables in `openai.ts` keep the rest of the codebase on the Anthropic-native canonical format; only this one module knows about the chat-completions dialect.

---

## Architecture Decisions

### One provider module per dialect, canonical format stays Anthropic-shaped

The codebase speaks Anthropic-native (content blocks on assistant messages, a separate `tool_result` role). The OpenAI provider has two translation tables:

1. **Message conversion** — collapse content blocks into OpenAI's flat shape (`tool_calls` array on assistant, `role: "tool"` for each result).
2. **Stream mapping** — OpenAI correlates streaming tool calls by `index`, with `id`/`name` only on the first delta per index. We synthesize `tool_call_start` / `tool_call_end` events to match the Anthropic-shaped `StreamEvent` that the accumulator expects.

Thinking blocks are dropped on this path — chat completions has no equivalent, and supporting `/v1/responses` for the sake of a reasoning UI wasn't worth doubling the dialect surface in a portfolio project. Cache-write tokens are also dropped (OpenAI's prompt caching is automatic and only reports `cached_tokens` reads).

### `stream_options: { include_usage: true }` is mandatory

Without it, chat completions emits deltas only — no token counts arrive. With it, the final chunk carries an empty `choices` array plus a `usage` object. The mapper grabs it and keeps going rather than returning early.

### Empty-response retry is a tight inner loop, not turn-loop trickery

Occasionally the model returns an empty `stop`-terminated turn (decoding flake, rare refusal). The naive fix — "decrement `turn` and `continue`" — entangles the retry semantic with the context tracker and the event stream. Sprint 7 extracts `streamTurnWithEmptyRetry` which:

- Retries exactly once on `content.length === 0 && stopReason === "stop"`.
- Returns `{ assistantMessage, droppedUsage: TokenUsage[] }`. The caller folds `droppedUsage` into both `totalUsage` and the context tracker so `/cost` matches the provider dashboard — the message is discarded, the bill isn't.
- Calls `config.signal.throwIfAborted()` before the retry. If the user cancelled during the empty turn, the `DOMException` bubbles through the caller's existing abort handling and terminates with `stopReason === "aborted"` rather than silently returning the empty message (which would have looked like `"done"`).
- If both attempts are empty, persists the second (still-empty) assistant message. No tool calls ⇒ `"done"`. The caller surfaces it honestly.

### `friendlyProviderError` rewrites only the hot-path failures

401, 403, 404, 400 (when the payload mentions a length/context limit), and 429 get actionable wording ("check your API key", "model not found; check tokenius.json", "`/clear` and retry"). Everything else passes through — we'd rather show the SDK's exact message than guess and mislead. The raw error is attached as `cause` so `--debug` still sees the stack.

### `/usage` is a superset of `/cost`, sharing one summarizer

`/cost` shows a two-line token + cost breakdown. `/usage` adds session id, title, turns, tool call count, and context-window percentage. Both share `summarizeSession(ctx): SessionTotals` and `writeTokenBreakdown(ctx, totals)`. This keeps the numbers guaranteed-identical across the two commands (a previous sketch computed them twice with slightly different filters).

### `/replay` — dropped

Originally scoped for a demo/review experience: stream a saved session's messages with a fake per-character delay, skipping tool execution and API calls. Cut because:

- Sessions live as plain JSONL at `~/.tokenius/sessions/*.jsonl`. `jq` or `cat` already shows everything a replay would.
- The pretty version earns its complexity only inside a richer TUI (syntax highlighting, collapsible tool blocks). Sprint 9 territory, not a polish item.
- Nothing else in the harness depends on it.

The decision is noted in PLAN.md under `/replay` Command — Dropped` so it's discoverable.

### Ripgrep is optional, not required

Earlier drafts aborted the tool with an install hint if `rg` wasn't on PATH. Sprint 7 replaces that with a pure-Bun walker: `Bun.Glob("**/*").scan({ onlyFiles: true, dot: false })` + in-process regex. Caps: 50 MB byte budget, 500 match limit, `FALLBACK_IGNORE = { node_modules, dist }` on top of Glob's built-in dotfile skip (`.git`, `.tokenius`, `.env` etc. are all dot-prefixed).

Slower than ripgrep on large trees — that's the whole point of having `rg` as the preferred path — but it means `bun run dev` works out of the box on a fresh machine with nothing but Bun installed. `hasRipgrep()` memoizes the detection so we don't fork per call.

### `MissingApiKeyError` is a typed class, not a string match

The CLI needs to distinguish "bad API key" (render a landing page with the key URL + `.env` snippet) from "bad config" (already handled), and catch-by-type is the only non-fragile way. Bare `Error` with a recognizable message would require substring-matching in the catch — invalidated by any future wording change.

### `messages.ts` extracted so `cli/index.ts` stays under 300 lines

The missing-key landing page is ~25 lines of chrome (colored bars, URL table, `.env` / `export` snippets). Inlining it in `runCLI` pushed `index.ts` past the 300-line threshold configured in `.oxlintrc.json`. Splitting into `src/cli/messages.ts` dropped it to 268 and has the side benefit that banner / first-run-hint / missing-key chrome are all in one file — easy to restyle.

---

## Post-Review Hardening

Code review surfaced five issues that were fixed before sprint close:

| #   | Issue                                                                                 | Fix                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Empty-retry dropped usage silently — `/cost` diverged from provider dashboard         | Refactored retry into `streamTurnWithEmptyRetry` returning `{ assistantMessage, droppedUsage }`. Caller folds `droppedUsage` into `totalUsage` + `updateTokenTracking` so billing stays honest.          |
| 2   | Signal abort during empty-retry silently returned the empty message as `"done"`       | Inner retry now calls `config.signal.throwIfAborted()` before re-streaming. `DOMException` bubbles through the outer catch and normalizes to `stopReason === "aborted"`. Verified in Bun via smoke test. |
| 3   | `cached_tokens: 0` was dropped by nullish-coalesce, losing telemetry signal           | Explicit `cachedTokens !== undefined` check + conditional spread. A confirmed cache miss stays on the usage object.                                                                                      |
| 4   | `cli/index.ts` over the 300-line soft-cap after inlining the missing-key block        | Extracted `printBanner`, `printFirstRunHint`, `printMissingApiKey` to `src/cli/messages.ts`. Index down to 268.                                                                                          |
| 5   | Dead helper in grep fallback (`relative(resolved, join(resolved, sep, rel))` → `rel`) | Dropped the no-op, use `rel` directly. Unrelated parameter-properties lint warning on `MissingApiKeyError` fixed with explicit class fields.                                                             |

The three `describe.skip` tests in `tools/grep.test.ts` are platform-conditional (skip when `rg` isn't installed) and are working as designed — not a regression.

---

## Key Implementations

### OpenAI provider — conditional `baseURL` spread

`exactOptionalPropertyTypes` forbids passing `undefined` where the option is typed `string | undefined`, so we omit the key entirely when no override exists:

```ts
const client = new OpenAI({
  apiKey: config.apiKey,
  ...(config.baseUrl !== undefined && { baseURL: config.baseUrl }),
});
```

The same trick appears on the `tools` parameter in `chat.completions.create` — empty tool arrays aren't the same as "no tools", and some OpenAI-compatible endpoints (xAI has been flaky) validate this strictly.

### OpenAI stream mapping — tracking `openIndex`

```ts
for (const tc of delta.tool_calls ?? []) {
  if (openIndex !== null && tc.index !== openIndex) {
    yield { type: "tool_call_end" };
    openIndex = null;
  }
  if (openIndex === null) {
    if (!tc.id || !tc.function?.name) continue; // guard off-spec providers
    yield { type: "tool_call_start", id: tc.id, name: tc.function.name };
    openIndex = tc.index;
  }
  const args = tc.function?.arguments;
  if (typeof args === "string" && args.length > 0) {
    yield { type: "tool_call_delta", arguments: args };
  }
}
```

`id` + `name` only arrive on the first delta per `index`. Subsequent deltas for the same index carry argument fragments only. The `openIndex` tracker synthesizes start/end events to match the Anthropic-shaped `StreamEvent` contract the accumulator expects.

### `streamTurnWithEmptyRetry` — billing-aware inner loop

```ts
async function streamTurnWithEmptyRetry(config: StreamTurnConfig): Promise<StreamTurnResult> {
  const MAX_ATTEMPTS = 2;
  const droppedUsage: TokenUsage[] = [];
  let assistantMessage: AssistantMessage | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const stream = streamWithRetry(
      config.provider,
      config.model,
      {
        /* … */
      },
      config.signal,
    );
    assistantMessage = await accumulateStream(stream, config.onEvent);

    const isEmptyStopTerminated =
      assistantMessage.content.length === 0 && assistantMessage.stopReason === "stop";
    if (!isEmptyStopTerminated) return { assistantMessage, droppedUsage };

    if (attempt < MAX_ATTEMPTS - 1) {
      config.signal.throwIfAborted(); // abort between attempts → "aborted"
      droppedUsage.push(assistantMessage.usage ?? ZERO_USAGE);
      debug("loop", "empty response, retrying", assistantMessage.usage);
    }
  }
  return { assistantMessage: assistantMessage!, droppedUsage };
}
```

The caller in `agentLoop`:

```ts
for (const droppedUsage of turnResult.droppedUsage) {
  totalUsage = addUsage(totalUsage, droppedUsage);
  updateTokenTracking(tracker, droppedUsage);
}
```

One loop, two places to fold: the session total (so `/cost` is honest) and the context tracker (so a wasted retry still counts toward exhausting the window, matching what the provider will see on the next request).

### `friendlyProviderError` — switch on status, preserve `cause`

```ts
export function friendlyProviderError(error: Error): Error {
  const status = (error as unknown as Record<string, unknown>)["status"];
  if (typeof status !== "number") return error;

  const wrap = (message: string) => Object.assign(new Error(message), { cause: error });

  switch (status) {
    case 401:
      return wrap("401 — check your API key (env var or .env file).");
    case 403:
      return wrap("403 — permission denied for this model or feature.");
    case 404:
      return wrap("404 — model not found. Check tokenius.json.");
    case 429:
      return wrap("429 — rate limit hit. Retry in a moment.");
    case 400:
      return /too long|context|maximum/i.test(error.message)
        ? wrap("400 — prompt exceeds the context window. Run /clear and retry.")
        : wrap(`400 — ${error.message}`);
    default:
      return error;
  }
}
```

### `MissingApiKeyError` — typed class with provider + envVar

```ts
export class MissingApiKeyError extends Error {
  readonly provider: ProviderId;
  readonly envVar: string;

  constructor(provider: ProviderId, envVar: string) {
    super(`Missing ${envVar}. Set it in your environment or .env file.`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
    this.envVar = envVar;
  }
}
```

Caught in `runCLI`:

```ts
try {
  // … bootstrap config, provider, session …
} catch (error) {
  if (error instanceof MissingApiKeyError) {
    printMissingApiKey(error);
    process.exit(1);
  }
  throw error;
}
```

### Grep fallback — pure-Bun walker with caps

```ts
const FALLBACK_IGNORE = new Set(["node_modules", "dist"]);
const FALLBACK_BYTE_BUDGET = 50_000_000;
const FALLBACK_MATCH_LIMIT = 500;

for await (const rel of new Bun.Glob("**/*").scan({
  cwd: resolved,
  onlyFiles: true,
  dot: false, // skips .git, .tokenius, .env automatically
})) {
  if (FALLBACK_IGNORE.has(rel.split(sep)[0] ?? "")) continue;
  // … byte budget check, readFile, regex match, MATCH_LIMIT enforcement …
}
```

Intentionally doesn't try to match ripgrep features (PCRE2, `-g` globs, multiline by default). It's a fallback: the 95% case of "grep some regex under this dir" works, power users install `rg`.

---

## Test Coverage

**367 pass, 3 skip, 0 fail** across 35 test files (+43 pass, +1 file vs Sprint 6).

| Module             | What's covered                                                                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `providers/openai` | Tool schema conversion (empty → undefined; populated); message conversion (user/assistant/tool_result roundtrip, merge consecutive text, drop thinking) |
|                    | Stream mapping — tool calls correlated by index, id/name first-delta guard, arg fragments, usage via final chunk, finish_reason normalization           |
| `providers/retry`  | `friendlyProviderError` — 401/403/404/400-context/400-other/429 rewrites; `cause` preserved; non-numeric status + unknown codes pass through            |
| `agent/loop`       | + Empty-retry (single retry, usage billed even when message dropped); abort between attempts reports `"aborted"`; second empty persists the empty turn  |
|                    | + `context_limit` when input tokens breach window reserve                                                                                               |
| `cli/commands`     | + `/usage` emits session id, title, turn count, tool-call count, context-window %; shares numbers with `/cost`                                          |
| `config/api-keys`  | `resolveApiKey` throws `MissingApiKeyError` with correct `provider` + `envVar` when env var missing; returns value when present                         |
| `config/loader`    | `baseUrl` accepted for `openai`; rejected with a clear message for `anthropic`                                                                          |
| `tools/grep`       | Fallback walker hit via `resetRipgrepCache` + env manipulation — match path, ignore-case, files_only, `FALLBACK_IGNORE` directories skipped             |

The three `describe.skip` tests are the ripgrep-gated paths on machines without `rg` — intentional, not bugs.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated. Main reconciliations:

- **OpenAI provider uses conditional `baseURL` spread**, `stream_options: { include_usage: true }`, `max_completion_tokens` (not `max_tokens`), and yields `message_start` before delegating to `mapChunks`. Plan showed an unconditional `baseURL`, the legacy `max_tokens`, and no explicit `message_start`.
- **`friendlyProviderError` extends `streamWithRetry`.** Plan stopped at `isRetryable`. Sprint 7 adds a post-retry error-rewrite step that preserves `cause`, documented in a new subsection in PLAN §Retry.
- **Empty-response retry is new code, documented.** Plan mentioned "edge case tests" for Sprint 7.4 but didn't sketch the behavior. New PLAN subsection covers billing + abort-between-attempts semantics.
- **Grep has a pure-Bun fallback.** Plan explicitly said "no manual fallback — the degraded code path would be slower and worse." Reversed in Sprint 7: "works without dependencies" beat "best-in-class or nothing" for a portfolio project. The PLAN grep docstring has been updated to describe the fallback caps.
- **`MissingApiKeyError` is a typed class.** Plan sketched `throw new Error(...)`. Bumped to a subclass so the CLI can catch-by-type.
- **`/usage` shares `summarizeSession` with `/cost`.** Plan had two independent sketches; implementation uses one helper so the two commands can't drift.
- **`/replay` dropped entirely.** Plan had a full sketch — now marked as dropped with rationale. Sprint 7 table shows `~~7.3~~`. ROADMAP.md also reflects this.
- **First-run missing-key UX lives in `cli/messages.ts`**, not `cli/index.ts`. Line-count pragma; also pulls `printBanner` / `printFirstRunHint` alongside so all CLI chrome is in one file.

---

## Running It

```bash
# Install + start the REPL
bun install
bun run dev                               # Anthropic by default

# Configure an OpenAI-compatible endpoint (xAI example)
#   tokenius.json:
#     { "provider": "openai", "model": "grok-2", "baseUrl": "https://api.x.ai/v1" }
OPENAI_API_KEY=sk-… bun run dev

# Missing key? You'll get a friendly landing page, not a stack trace.
unset ANTHROPIC_API_KEY && bun run dev

# Inside the REPL:
#   /usage    — detailed token + cost + context-window view
#   /cost     — short cost summary
#   /help     — full command list

# Full check suite (lint, format, typecheck, knip, 367 tests)
bun run check
```

**Sprint 7 done.** The harness has two providers, handles common provider errors gracefully, survives missing ripgrep, and lands new users on a friendly page when the API key isn't set. Sprint 8 is documentation, CI, and packaging — the README, architecture diagram, and GitHub Actions workflow that turn this into a portfolio-ready repo.
