# Sprint 1 Summary: Provider Layer

**Status:** Complete  
**Milestone:** Send a prompt to Claude and stream the response to the terminal.

---

## What Was Built

Sprint 1 establishes the **LLM provider abstraction** — the lowest layer of the harness. It handles talking to LLMs, streaming responses, calculating costs, and recovering from errors.

### Files Created

```
src/
├── types.ts                    # Core types shared across all layers
├── smoke.ts                    # End-to-end test (prompt → stream → terminal)
├── index.ts                    # Bootstrap placeholder
├── providers/
│   ├── types.ts                # Provider interface + LLMContext
│   ├── models.ts               # Model metadata (6 models, pricing, limits)
│   ├── cost.ts                 # Token cost calculation
│   ├── anthropic.ts            # Anthropic SDK adapter
│   ├── registry.ts             # Provider registry (Map-based, fail-fast)
│   ├── retry.ts                # Retry with exponential backoff
│   ├── partial-json.ts         # Partial JSON recovery for streamed args
│   └── *.test.ts               # Tests for each module (39 total)
```

---

## Architecture Decisions

### Canonical Message Format

We use an **Anthropic-flavored internal format** — content blocks (text, thinking, tool_call) inside messages. When the OpenAI provider arrives (Sprint 7), it will reshape to/from this canonical format. This means two converters cover the entire market.

```
Internal format ←→ Anthropic SDK (direct mapping)
Internal format ←→ OpenAI SDK (reshape tool_calls array)
```

**Why:** Anthropic's content-block model is more expressive (supports thinking blocks natively). Converting from richer → simpler is easier than the reverse.

### Streaming via Async Generators

Every LLM interaction is an `AsyncIterable<StreamEvent>`. No "fetch all, then display." The stream produces a discriminated union of 8 event types:

| Event             | Purpose                                 |
| ----------------- | --------------------------------------- |
| `message_start`   | New response began                      |
| `text_delta`      | Incremental text chunk                  |
| `thinking_delta`  | Incremental thinking chunk              |
| `tool_call_start` | Tool invocation begun (id + name)       |
| `tool_call_delta` | Incremental JSON arguments              |
| `tool_call_end`   | Tool invocation complete                |
| `message_end`     | Response complete (usage + stop reason) |
| `error`           | Stream error                            |

**Why discriminated unions:** TypeScript's exhaustiveness checking forces us to handle every event type. You can't accidentally forget one in a `switch` statement.

### Provider Pattern

Each provider implements a single interface:

```typescript
interface Provider {
  id: ProviderId;
  stream(model: string, context: LLMContext, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
```

The Anthropic provider has explicit `convertMessages()` and `convertTools()` functions — they show exactly what shape transformation happens. No magic, no inheritance.

### Fail-Fast Config, Graceful Runtime

Two different error philosophies depending on context:

- **Config errors** (unknown model, unknown provider): throw immediately with a helpful message. Bad config shouldn't hide.
- **Runtime errors** (partial JSON, stream interruption): degrade gracefully. Partial JSON parser never crashes — worst case returns `{}`.

---

## Key Implementations

### Model Metadata (`models.ts`)

Single source of truth for 6 models (3 Anthropic, 3 OpenAI). Each entry has: id, provider, context window, max output tokens, pricing (input/output/cache read/cache write), caching support.

When a new model ships, one file update. Unknown models throw immediately with "Add it to MODELS" instruction.

### Cost Calculation (`cost.ts`)

`calculateCost(model, usage)` sums: `(input × inputPrice) + (output × outputPrice) + (cacheRead × cacheReadPrice) + (cacheWrite × cacheWritePrice)`.

`addUsage(a, b)` accumulates token counts across multiple API calls within a session.

### Anthropic Provider (`anthropic.ts`)

Creates the SDK client, converts messages both directions, maps Anthropic's 12+ stream event types down to our common 8. Returns `null` for events we don't use (e.g., `message_stop`, `signature_delta`) — the consumer skips them.

**Usage merging:** Anthropic splits token usage across two stream events — `message_start` carries input tokens (+ cache tokens), `message_delta` carries output tokens. The provider captures input usage in the generator closure and merges it into the `message_end` event, so consumers see complete `TokenUsage` in one place.

Key conversions:

- Our `tool_call` blocks → Anthropic's `tool_use` blocks
- Our `ToolResultMessage` → Anthropic's `tool_result` content block inside a user message
- Anthropic stream events → our `StreamEvent` union

### Retry Logic (`retry.ts`)

`streamWithRetry()` wraps `provider.stream` with exponential backoff: 1s → 2s → 4s, max 3 retries.

Retryable conditions:

- HTTP 429 (rate limit), 500, 502, 503, 529 → retry
- Network errors (TypeError, connection reset) → retry
- AbortError → never retry (user cancelled)
- Client errors (4xx) → never retry (our fault)

### Partial JSON Parser (`partial-json.ts`)

Recovers tool call arguments when a stream is cut mid-JSON. Algorithm:

1. Try `JSON.parse()` (fast path — usually works)
2. Close unclosed strings (track escape sequences)
3. Strip trailing incomplete key-value pairs: `{"a": true, "b":` → `{"a": true}`
4. Close remaining open brackets/braces in reverse order
5. Fallback to `{}` if still invalid

This is critical for the agent loop — when a stream errors mid-tool-call, we still get partial arguments rather than a crash.

### Provider Registry (`registry.ts`)

Simple `Map<ProviderId, Provider>`. Register at startup, look up by id. Unknown provider throws. `clearProviders()` exists for test teardown only.

---

## Type System Overview

```typescript
// Message types (canonical format)
type Message = UserMessage | AssistantMessage | ToolResultMessage;

// Content blocks inside AssistantMessage
type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;

// Stream events (discriminated union)
type StreamEvent =
  | { type: "message_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "message_end"; usage: TokenUsage; stopReason: string }
  | { type: "error"; error: Error };

// Provider interface
interface Provider {
  id: ProviderId;
  stream(model: string, context: LLMContext, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}
```

---

## Test Coverage

**39 tests, 0 failures.** Every module has co-located tests (`*.test.ts`):

| Module         | Tests | What's covered                                                         |
| -------------- | ----- | ---------------------------------------------------------------------- |
| `models`       | 3     | Known Anthropic/OpenAI lookup, unknown throws                          |
| `cost`         | 7     | Cost calc, token addition, cache tokens, zero usage, unknown model     |
| `retry`        | 9     | Retryable status codes, network errors, AbortError, non-Error values   |
| `partial-json` | 20+   | Complete JSON, unclosed strings/brackets, trailing commas, empty input |

Tests use Bun's native `test`/`describe`/`expect` — no external test library.

---

## Dependencies

**Runtime:** `@anthropic-ai/sdk` (the only one)

**Dev:** oxlint, oxfmt (Rust-based linting/formatting), lefthook + commitlint (git hooks), knip (dead code detection), @types/bun

**Intentionally excluded:** LangChain, Vercel AI SDK, external test libraries, dotenv (Bun handles `.env` natively).

---

## Tooling Setup

- **TypeScript:** Strictest settings — `strict`, `noImplicitReturns`, `noImplicitOverride`, `exactOptionalPropertyTypes`
- **Linter:** oxlint with strict rules — `no-explicit-any`, type imports enforced, import cycle detection
- **Formatter:** oxfmt (Rust-based, consistent with linter)
- **Dead code:** knip detects unused exports, dependencies, types
- **Git hooks:** Pre-commit runs lint + format + typecheck + test + knip. Commit messages validated against Conventional Commits.
- **Check command:** `bun run check` runs everything in one shot

---

## How It Connects to Sprint 2

Sprint 2 (Tools + Security) builds directly on top of this:

- The **`ToolSchema`** referenced in `LLMContext.tools` will get its implementation
- The **`tool_call_start`/`delta`/`end`** stream events will feed into tool execution
- The **partial JSON parser** will recover arguments from interrupted tool calls
- The **provider registry** will be the entry point for the agent loop to get a provider

The provider layer is a pure I/O boundary — it talks to LLMs and nothing else. Everything above it (tools, agent loop, sessions) depends on it but never reaches into its internals.

---

## Running It

```bash
# Install
bun install

# Run the smoke test (needs ANTHROPIC_API_KEY in .env)
bun run src/smoke.ts

# Run all tests
bun test

# Run full check suite
bun run check
```

The smoke test sends "What is a coding agent in 2-3 sentences?" to Claude, streams the response token by token, and prints the final usage + cost.
