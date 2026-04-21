# Sprint 3 Summary: Agent Loop

**Status:** Complete
**Milestone:** The agent loop works end-to-end. Streaming, tool execution, security gating, permission prompts, context tracking, and subagent delegation are all wired together behind one function — `agentLoop`.

---

## What Was Built

Sprint 3 delivers **Layer 3 (Agent Loop)** and **Layer 4 (Agents & Subagents)** from the plan, plus the permission-prompt half of Layer 5. The provider layer from Sprint 1 and the tool system from Sprint 2 now compose into something that can actually run: given a user message and an API key, the harness will call Claude, execute the tools Claude asks for, re-prompt, and return. No CLI yet — Sprint 6 — but the core machinery runs end-to-end in tests.

### Files Added

```
src/
├── agent/
│   ├── types.ts                  # AgentConfig, AgentEvent, AgentEventHandler
│   ├── agents.ts                 # AGENTS registry (build, plan, explore)
│   ├── context-tracker.ts        # Real-token tracking + hard stop
│   ├── stream.ts                 # StreamEvent → AssistantMessage accumulator
│   ├── execute.ts                # validate / resolve perms / execute (3 phases)
│   ├── loop.ts                   # agentLoop — the one function
│   ├── system-prompt.ts          # Static builder (cache-friendly)
│   └── *.test.ts                 # Co-located tests
├── security/
│   ├── permissions.ts            # PermissionPrompter, PermissionStore, resolvePermissions
│   └── permissions.test.ts
├── tools/
│   ├── spawn-agent.ts            # Factory: createSpawnAgentTool(options)
│   └── spawn-agent.test.ts
└── testing/
    └── mock-provider.ts          # Scripted Provider + event builders (test-only)
```

Also touched: `src/providers/anthropic.ts` (fixed the Sprint 1 `content_block_stop` TODO), `src/tools/types.ts` (doc update on the `confirm` hook).

---

## Architecture Decisions

### One loop, explicit termination taxonomy

The loop exits via one of five `AgentStopReason` values — `done`, `aborted`, `context_limit`, `turn_limit`, `error`. The default is `turn_limit` so falling out of the `while` condition without an explicit set is reported truthfully rather than silently. Every other exit path sets it explicitly. Callers (and the `spawn_agent` tool in particular) branch on this enum, not on heuristics over the returned messages.

**Why this is the interesting bit:** termination is the hardest part of any agent loop to reason about. Hiding the reason behind a boolean `completed: true` loses information; the `spawn_agent` tool now turns `context_limit` / `turn_limit` / `error` into `isError: true` ToolResults so the parent LLM can actually react instead of treating partial output as finished work.

### Three-phase tool execution

The plan had `validateToolCalls` and `executeToolsSequential` as two functions with permission-prompting folded into validation. The implementation splits it into three:

1. **`validateToolCalls`** — pure function. JSON-schema + bash `checkCommand`. No prompter, no async. Testable in isolation.
2. **`resolveValidatedPermissions`** — async. Consults the store, calls the prompter, mutates validated results in place.
3. **`executeToolsSequential`** — async. Runs approved tools, truncates output, wraps as `ToolResultMessage`.

Three reasons for the split: (1) tests can drive each phase without the others, (2) `validateToolCalls` is synchronous and pure — easy to reason about, (3) the CLI (Sprint 6) can insert UI between phases 2 and 3 (e.g. a progress spinner) without refactoring the loop.

### Tool allow-list as defense-in-depth

`validateToolCalls(toolCalls, agent.tools)` rejects any tool call whose name isn't in the agent's allow-list. The LLM only _receives_ schemas for allowed tools, so this shouldn't happen in practice — but a recycled message history or a malformed stream could smuggle in a tool name the current agent isn't supposed to run. `plan` and `explore` subagents in particular must never get `write`/`edit`/`bash`, and this is the second line of defense after the schemas.

### `PermissionPrompter` + `PermissionStore` — separated concerns

Permissions have two independent concerns: _how the user is asked_ (readline now, TUI later) and _what we remember_ (the session-scoped "allow for session" set). Splitting them into `PermissionPrompter` (function) and `PermissionStore` (object) lets us:

- Swap the UI in Sprint 6 without touching the loop.
- Inject fakes in tests — `denyPrompter`, `throwingPrompter`.
- Let subagents inherit the parent's store so the user isn't re-prompted mid-run for a category already approved.
- Keep the store out of module state — two concurrent loops can't cross-contaminate.

### `SESSION_EXCLUDED_REASONS` — not all confirms are equal

Some CONFIRM categories never get session-scoped approval: `sudo`, force push, hard git reset, force-delete branch, SQL drops. `allow_session` on an excluded reason is silently downgraded to a one-time allow. The inclusion criterion is simple: **irreversible** (no `reflog` path back) or **affects state outside the local repo**. Destructive-but-contained ops (`rm -rf ./dist`, `git clean`) stay session-allowable so tight dev loops aren't constantly interrupted.

### `spawn_agent` as a factory, not a module global

The plan had `spawn_agent` read module-level `currentProvider` / `currentModel` / `onEvent` variables. The implementation uses a factory: `createSpawnAgentTool({ provider, model, cwd, onEvent, agentsMd, prompter, permissionStore })` returns a ready-to-register `ToolDefinition`. The CLI calls this once at startup and registers the result.

Three reasons: (1) avoids module state that would complicate testing, (2) safer for any future concurrent-subagent scenarios, (3) the factory signature documents exactly what the tool depends on. The subagent's raw `AgentEvent` stream is deliberately NOT forwarded to the parent — they'd interleave confusingly. The parent only sees a single `subagent_complete` summary event with turns, tokens, and cost.

### Stream accumulator: two invariants

`accumulateStream` consumes the provider's `StreamEvent`s and assembles one `AssistantMessage`. It protects two invariants that tripped me up in the first pass:

1. **Text/thinking deltas extend the _most recent_ block of that kind.** If the stream interleaves `text → tool_call → text`, that's two separate `TextBlock`s — the `tool_call` in between breaks the run. Simple to get wrong; breaks message replay.
2. **Tool-call arguments buffer per-id, not globally.** Multiple tool calls in one turn each keep their own raw JSON buffer, so they can't cross-contaminate. Parsing happens on `tool_call_end` via `parsePartialJson` (partial-JSON recovery from Sprint 1).

### `buildSystemPrompt` stays pure

The plan had the builder load AGENTS.md and discover skills from the filesystem. The implementation takes them as options and lets the caller load them once. Two reasons: (1) keeps the builder testable without touching disk, (2) the CLI caches these loads once per session, not per subagent call. Skills are intentionally deferred — a placeholder hook now would force text into the prompt and pollute the cache prefix before Sprint 5 can fill it in meaningfully.

---

## Key Implementations

### `agentLoop` — input immutability

Input `messages` are cloned on entry. Every push (assistant messages, tool results) goes into the clone, which is returned on the result. The caller keeps its own reference. This matters most for the CLI: the session history lives in the CLI layer, and we don't want the loop silently deciding what persists.

### Context tracking: real tokens, no estimation mid-session

`updateTokenTracking` snapshots `usage.inputTokens` after every LLM response — the authoritative count the provider charged us for. `estimateTokens` (4 chars/token heuristic) is only used for the very first message, before any response has come back. `CONTEXT_RESERVE = 20_000` is headroom for the system prompt, tool schemas, and max output; cheaper to stop one turn early than blow through mid-request. The check runs at the _start_ of the next turn, so the turn that _produced_ the huge usage still gets its full response — only the following turn is short-circuited.

### Stream abort normalization

When a user Ctrl+C's mid-stream, the SDK throws its own abort error. The loop's catch block checks `signal.aborted` and rewrites this to `stopReason = "aborted"` instead of `"error"`. Small thing, but it means the end-of-turn UX can say "cancelled" instead of a scary stack trace.

### `confirm` hook gets pre-resolved `true`

The agent loop pre-prompts for permissions in phase 2, so when phase 3 calls `tool.execute(args, ctx)`, `ctx.confirm` is `() => Promise.resolve(true)`. Denied calls already became `v.error` upstream — they never reach `execute`. This keeps the bash tool simple: it still has the `confirm?.(…)` hook in its code (for direct/test invocation), but in loop-driven runs it's always auto-approved. No double-prompting, no race.

### `spawn_agent` error propagation

`buildResult(stopReason, text)` translates subagent stop reasons into a parent-facing `ToolResult`:

| Stop reason     | Parent sees                                                      |
| --------------- | ---------------------------------------------------------------- |
| `done`          | clean `{ content: text }`                                        |
| `error`         | `{ content: "... [subagent errored]", isError: true }`           |
| `aborted`       | `{ content: "... [subagent aborted]", isError: true }`           |
| `turn_limit`    | `{ content: "... [subagent hit turn limit]", isError: true }`    |
| `context_limit` | `{ content: "... [subagent hit context limit]", isError: true }` |

Empty text on `done` becomes `"(subagent produced no response)"` so the parent has something concrete to react to.

### `MockProvider` — scripted streams for tests

`src/testing/mock-provider.ts` is a scripted `Provider`: `createMockProvider([script1, script2, ...])` returns a provider whose `stream()` yields the next pre-built `StreamEvent[]` on each call. With helpers (`textDelta`, `toolCall`, `messageEnd`), a whole end-to-end loop scenario is ~10 lines. This is what powers the Sprint 3 end-to-end test — no mocks-of-mocks, no network.

### Anthropic provider: two bug fixes while we were here

1. **`content_block_stop` used to always emit `tool_call_end`.** That was wrong for text and thinking blocks. The provider now tracks the active block type across start/stop and only emits `tool_call_end` when the closed block was `tool_use`. Unknown future block types (e.g. `server_tool_use`) stay null — safer than guessing.
2. **`stop_reason` is now normalized.** Anthropic ships `end_turn` / `tool_use` / `max_tokens` / `stop_sequence` / `refusal`. We collapse these to our canonical `"stop" | "tool_use" | "length" | "error"` at the provider boundary so downstream layers can rely on a closed set. `accumulateStream` has a last-resort `coerceStopReason` guard as well — defense against a buggy provider smuggling an off-spec string into persisted history.

---

## Test Coverage

**220 pass, 3 skip, 0 fail** across 24 test files. Highlights added this sprint:

| Module            | What's covered                                                                                                                            |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `context-tracker` | `isContextExhausted` thresholds, `estimateTokens`, window from model metadata                                                             |
| `stream`          | Text/thinking runs, interleaved tool calls, multi-tool-call buffers, partial JSON, errors                                                 |
| `execute`         | Unknown tool, bad args, bash blocked/confirm, permission deny, throwing tool, truncation                                                  |
| `permissions`     | Store pre-resolution, prompter for unresolved, excluded-reason downgrade, length mismatch                                                 |
| `system-prompt`   | With/without AGENTS.md, trimming, static output (no dynamic content)                                                                      |
| `loop`            | Done, aborted (pre-start + mid-stream), tool-call cycle, disallowed tool, turn_limit, context_limit, input immutability                   |
| `spawn-agent`     | Unknown agent, build refusal, text-only subagent, cost event, no event forwarding, error/turn_limit propagation, `no response` empty case |

The end-to-end `loop.test.ts` drives the full stack — `streamWithRetry` → `accumulateStream` → `validateToolCalls` → `resolveValidatedPermissions` → `executeToolsSequential` — using the `MockProvider` for every scenario above. No network, no real filesystem, fully deterministic.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated. The main changes:

- **`AgentLoopConfig`** — `tools` removed (loop reads from registry); `cwd` and `signal` are required; added `prompter?`, `permissionStore?`; `maxTurns?` is an override; `messages` is `readonly`.
- **`AgentLoopResult`** — added `stopReason: AgentStopReason`.
- **`AgentEvent`** — added `turn_limit_reached` and `subagent_complete`.
- **`streamResponse` → `accumulateStream`** — renamed and documented the invariants; added missing-`message_end` guard; added `coerceStopReason` for a closed-set stopReason.
- **Tool execution split into 3 functions** — `validateToolCalls` + `resolveValidatedPermissions` + `executeToolsSequential`, with per-tool try/catch and abort-between-tools honored.
- **`spawn_agent`** — factory pattern (`createSpawnAgentTool`) instead of module globals; `stopReason`-driven error result; parent gets a `subagent_complete` event instead of a fake `tool_result`.
- **`buildSystemPrompt`** — takes options with `agentsMd` passed in; skills deferred to Sprint 5.
- **Permissions** — `PermissionPrompter` + `PermissionStore` + `resolvePermissions`; added `SESSION_EXCLUDED_REASONS`; `sessionPermissions` module global removed.
- **Anthropic provider** — `content_block_stop` now emits `tool_call_end` only for tool blocks; `stop_reason` normalized at the provider boundary.

---

## How It Connects to Sprint 4

Sprint 4 (Session Persistence) slots into the CLI layer (not the loop). The loop already returns `{ messages, usage, turns, stopReason }`; the session manager will:

- Create a JSONL file on new sessions, append entries (`SessionHeader` + `MessageEntry` per `Message`).
- Load a session by reconstructing the messages array from the JSONL.
- List sessions via the header line of each file (filter by `cwd`).

The loop's input-immutability contract matters here: the CLI owns `session.messages`, hands a reference to the loop, and takes the returned clone. The session file is the source of truth; the loop is stateless.

The `stopReason` values persist naturally — when `context_limit` fires, the CLI can surface `"Session context full. Start a new session or use /clear."` before writing the final turn to disk.

---

## Running It

```bash
# All tests (220 pass, 3 skip)
bun test

# Full check suite (lint, format, typecheck, knip, test)
bun run check

# Smoke test the provider layer (needs ANTHROPIC_API_KEY)
bun run src/smoke.ts
```

No interactive CLI yet — that's Sprint 6. The agent loop runs end-to-end today through `loop.test.ts` and `spawn-agent.test.ts` with scripted providers; once the CLI bootstraps `createSpawnAgentTool` and wires a real provider, the same loop will drive real conversations.
