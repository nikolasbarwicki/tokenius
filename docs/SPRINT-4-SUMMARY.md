# Sprint 4 Summary: Session Persistence

**Status:** Complete
**Milestone:** Sessions persist to disk as append-only JSONL and can be loaded back. The agent loop is now a stateless function over a durable conversation log — ready for the CLI to wrap in Sprint 6.

---

## What Was Built

Sprint 4 delivers **Layer 6 (Session Persistence)** from the plan. Each session is one `.tokenius/sessions/{id}.jsonl` file in the project directory: a header line followed by one message entry per `Message`. The manager exposes five small functions — `createSession`, `appendMessage`, `setTitle`, `loadSession`, `listSessions` — plus a separate `generateSessionTitle` that turns the first user message into a short display title after the first turn.

No CLI yet (Sprint 6), but the persistence contract is fixed: the loop stays stateless, the session file is the source of truth, and titles arrive asynchronously without breaking the write order.

### Files Added

```
src/
└── session/
    ├── types.ts              # SessionHeader, MessageEntry, Session, SessionSummary
    ├── manager.ts            # create / append / setTitle / load / list (sync fs)
    ├── manager.test.ts       # Roundtrip, listing, sort, malformed-file skip
    ├── title.ts              # generateSessionTitle + truncateForTitle
    └── title.test.ts         # Accumulation, sanitize, abort/error fallback
```

No other files were modified. The loop's `AgentLoopResult.messages` from Sprint 3 is already the exact shape `appendMessage` wants; the integration lives in the CLI layer next sprint.

---

## Architecture Decisions

### Header-first JSONL, append-only

Line 1 is the `SessionHeader` (type, id, timestamp, cwd, model, optional title). Line 2+ is one `MessageEntry` per `Message`. This layout has three properties that matter:

1. **Listing is cheap.** `listSessions` reads just the first line of each file to build a summary — no parsing the whole conversation to show it in a picker.
2. **Appends are atomic at the line level.** A crash during a write loses at most the in-flight line; everything before it is already durable. No journaling, no two-phase commit, no lock file.
3. **Replay is trivial.** Split on newlines, `JSON.parse` each, the message array is in the order it was produced. No cut points, no summaries, no stitching.

**Why this is the interesting bit:** agent transcripts are fundamentally an append-only log. Any more sophisticated format (SQLite, CBOR, proto) is buying features we don't need and paying with complexity we do feel.

### No compaction, ever

When the context window fills, the session hard-stops (`stopReason: "context_limit"` from Sprint 3). The user starts a new session or uses `/clear`. This is the single biggest simplification in the entire layer — it removes cut-point detection, LLM-driven summarization, cheap-model routing, and a whole class of "what did the summary lose?" bugs. The tradeoff is honest: long tasks don't survive context exhaustion. For a personal coding agent that's the right call. The file format stays flat because there's no summary entry type to introduce.

### Standalone functions, not a `SessionManager` class

The plan sketched a `SessionManager` interface with `create/list/load/append`. The implementation is five free functions. There's no state to carry — each call takes `cwd` and does its I/O. The CLI holds the one live `Session` it cares about in a local variable. Module-global state would force an "is there a current session?" guard on every operation, and would make concurrent flows (parent + subagent on different sessions, future tests in parallel) harder than they need to be.

### `appendMessage` takes a `Message`, not a `SessionEntry`

The plan had a generic `append(sessionId, entry: SessionEntry)`. The implementation narrows to `appendMessage(cwd, sessionId, message)`. Messages are the only thing ever appended after the header; exposing a generic `append` is a footgun — nothing would stop a caller from writing a second header line and quietly corrupting the file. Narrower surface, stronger invariant.

### `setTitle` is a new primitive, atomic via tmp + rename

The plan had titles written at session creation. In practice the title isn't _knowable_ until after the first turn — we summarize the first user message via the LLM, and that call can fail or time out. So titles arrive late, which means rewriting an existing file's first line. `setTitle`:

1. Reads the whole file, locates the first `\n`.
2. Writes `{new-header}\n{rest}` to `{path}.tmp`.
3. `renameSync(tmpPath, path)` — same filesystem, POSIX-atomic.

A crash at any step leaves either the original file intact or the new one in place. No truncated file, no half-written header. `session.header` is mutated in place so the in-memory copy doesn't drift from disk.

### `isFirstInProject` instead of printing

The plan had the manager print the `.gitignore` hint itself. The implementation returns `isFirstInProject: true` from `createSession` and lets the CLI decide what to show. Two reasons: (1) tests can create sessions without capturing stdout, (2) the CLI owns all rendering — no split-brain "who prints what?" logic once Sprint 6 lands.

### Listing ignores `header.cwd`

`listSessions(cwd)` reads `{cwd}/.tokenius/sessions/` and doesn't filter by the `cwd` field in each header. The filesystem path is already the scoping. The header `cwd` is kept as metadata (survives a repo move, tells you where the session was recorded) but it's not a filter. A file physically under this project's directory _is_ this project's session, full stop.

### Malformed files skip, don't fail

`listSessions` wraps the per-file parse in `try/catch` and `continue`s on failure. A truncated or hand-edited session file — perfectly plausible if the process was kill -9'd mid-write, or the user opened it in vim — shouldn't take out the whole `/sessions` picker. The rest of the list still renders; the broken file is silently dropped. Loading _that specific_ session still throws, which is the right failure mode (explicit user action, loud error).

### `generateSessionTitle` — best-effort, never surfaces errors

Title generation is cosmetic. If it fails, the session still works. The function catches everything — network errors, abort signals, timeouts, empty responses, the provider emitting an `error` stream event — and returns `truncateForTitle(firstUserMessage)` as the fallback. A 10-second `AbortSignal.timeout` is composed with the caller's signal via `AbortSignal.any` so a hung provider can't wedge the post-turn flow.

**Why a separate function:** the title call is structurally different from the main turn — different system prompt, different `maxTokens` (24), no tools, no persistence. Folding it into the loop would require special-casing; a standalone function reuses the `Provider.stream` contract directly and owns its own failure policy.

---

## Key Implementations

### `createSession` — UUIDv7 for time-sortable ids

Session ids are `Bun.randomUUIDv7()`. UUIDv7 is time-ordered (timestamp in the high bits), so lexicographic sort on the id is already chronological — useful for directory listings and future pagination. Collision-resistant, and doesn't require coordinating with the filesystem.

The first thing `createSession` does is check `existsSync(dir)` _before_ calling `mkdirSync(dir, { recursive: true })`. That ordering is what makes `isFirstInProject` reliable — you can't check after mkdir and still tell whether the dir was new.

### `appendMessage` — roundtrip tested across all message shapes

The roundtrip test appends a user message, an assistant message with `content`/`usage`/`stopReason`, and a tool_result message — then loads and asserts `loaded.messages` deep-equals the input array. This is the contract the CLI depends on: whatever shape `agentLoop` returns, the session will give back bit-for-bit.

### `setTitle` — atomic rewrite

```ts
const tmpPath = `${path}.tmp`;
writeFileSync(tmpPath, `${JSON.stringify(updated)}${rest}`);
renameSync(tmpPath, path);
```

`rest` keeps its leading `\n`, so the concatenation doesn't lose the header/body separator. The test verifies no `.tmp` file is left behind after a successful call — if the rename ever failed silently, that file would linger.

### `loadSession` — fail loudly on missing or malformed header

A session file with no lines, or with a first line that isn't a `type: "session"` header, throws. These aren't recoverable states — if someone hands us a bogus id or a corrupt file, the right behavior is a loud error at the call site, not returning an empty session that the UI will silently render as "no messages yet". Listing, by contrast, tolerates corruption (it's a directory scan over many files); loading is pointed at one file the user asked for.

### `listSessions` — `toSorted`, descending by timestamp

`Array.prototype.toSorted` is the non-mutating variant — matters here because the `summaries` array is built inside the function and nothing outside sees it, but using `toSorted` throughout the codebase keeps us away from `.sort()`'s in-place surprise. Descending `localeCompare` on ISO-8601 timestamps sorts newest-first, which is what the CLI picker will want.

### `generateSessionTitle` — stream composition with timeout

```ts
const timeoutSignal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
```

`AbortSignal.any` returns a signal that aborts when _any_ of its inputs abort. The caller's Ctrl+C still wins; the 10s timeout is an upper bound. Inside the loop, `text_delta` events are accumulated and `error` events are re-thrown so the outer `try/catch` routes both into the single fallback path — one code path for "something went wrong", no matter which layer produced it.

### `truncateForTitle` — the fallback fallback

Collapses all whitespace runs to single spaces, trims, returns `(untitled)` for all-whitespace input, otherwise clips to 40 characters with an ellipsis. This is what the session picker shows when the LLM call failed _and_ when the user bailed out before the first response completed. Cheap, deterministic, good enough.

### `MockProvider` reused across layers

The title tests use the same `createMockProvider` helpers introduced in Sprint 3 (`messageStart`, `textDelta`, `messageEnd`). No new test scaffolding — a scripted stream feeds `generateSessionTitle` the same way it feeds `agentLoop`. One more piece of evidence that the `Provider.stream` abstraction from Sprint 1 is carrying its weight.

---

## Test Coverage

**240 pass, 3 skip, 0 fail** across 26 test files (+20 pass, +2 files vs Sprint 3).

| Module            | What's covered                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| `session/manager` | `createSession` (header shape, `isFirstInProject` flag, id uniqueness)                               |
|                   | `appendMessage` + `loadSession` roundtrip (user / assistant / tool_result)                           |
|                   | `loadSession` throws on missing file                                                                 |
|                   | `setTitle` rewrites header without disturbing messages; no `.tmp` left behind                        |
|                   | `listSessions` empty dir, sort by timestamp desc, `messageCount`, reflects `setTitle`, skips garbage |
| `session/title`   | `truncateForTitle`: short / whitespace collapse / long with ellipsis / empty → `(untitled)`          |
|                   | `generateSessionTitle`: stream accumulation, quote/punctuation strip, empty-script throw fallback    |
|                   | Whitespace-only output fallback, mid-stream `error` event fallback                                   |

No integration test wires the session module into the loop yet — that's a CLI concern and lands in Sprint 6. The Sprint 3 end-to-end test already asserts loop → message-array fidelity, and Sprint 4's roundtrip tests assert message-array → file fidelity; the composition follows.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated. The main changes:

- **`MessageEntry`** — dropped per-message `id` and `timestamp`. The message itself is the record; ordering is file order. Future metadata, if needed, gets a new entry type rather than widening this one.
- **`SessionManager` interface → standalone functions.** `createSession`, `appendMessage`, `setTitle`, `loadSession`, `listSessions`, `sessionPath`. No module-level state.
- **`createSession` returns `CreateSessionResult`**, not just `Session`. Adds `path` and `isFirstInProject` so the CLI can show the `.gitignore` hint once.
- **`appendMessage(cwd, sessionId, message)`** instead of a generic `append(entry)`. The narrower signature makes "write a second header" impossible.
- **`setTitle` is new.** Titles arrive after the first turn; atomic rewrite via write-tmp + rename is the correct primitive.
- **First-run `.gitignore` hint** moved out of the manager. Manager returns `isFirstInProject`; CLI (Sprint 6) owns the print.
- **`generateSessionTitle` gained a `signal` parameter** and a 10s timeout. It composes both via `AbortSignal.any` and falls back to `truncateForTitle` on every failure path — no error ever reaches the caller.
- **`listSessions` tolerates malformed files.** One bad session file doesn't take out the picker; it's logged-and-skipped.

---

## How It Connects to Sprint 5 & 6

Sprint 5 (Config & Skills) is independent — no changes needed here.

Sprint 6 (CLI) is where the session module actually lights up. The wiring is:

```ts
const { session, path, isFirstInProject } = createSession(cwd, config.model);
if (isFirstInProject) console.log(`Session saved to ${path}\nTip: …`);

while (/* repl */) {
  const input = await readline();
  session.messages.push({ role: "user", content: input });
  appendMessage(cwd, session.id, session.messages.at(-1)!);

  const result = await agentLoop({ /* … */ messages: session.messages, /* … */ });
  for (const m of result.messages.slice(session.messages.length)) {
    appendMessage(cwd, session.id, m);
  }
  session.messages = result.messages;

  if (!session.header.title) {
    const title = await generateSessionTitle(input, provider, config.model, signal);
    setTitle(cwd, session, title);
  }
}
```

The loop's input-immutability contract from Sprint 3 matters here: `agentLoop` doesn't mutate the array it's handed, so the CLI can diff `result.messages` against the pre-call length and append only the new entries. The session file stays consistent with the in-memory `session.messages` with no extra bookkeeping.

`stopReason: "context_limit"` from Sprint 3 will trigger a CLI-side "Session context full. Start a new one or /clear." message — the session file is already on disk by then, so a user's work isn't lost.

---

## Running It

```bash
# All tests (240 pass, 3 skip)
bun test

# Full check suite (lint, format, typecheck, knip, test)
bun run check

# Smoke test the provider layer (needs ANTHROPIC_API_KEY)
bun run src/smoke.ts
```

Still no interactive CLI — Sprint 6. Session persistence is verified end-to-end through the roundtrip tests: every `Message` shape the loop can produce is serialized, split on newlines, re-parsed, and asserted equal to the input. The format is stable enough to commit to: any session file written today will load unchanged after the CLI ships.
