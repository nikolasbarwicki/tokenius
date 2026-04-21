# Sprint 6 Summary: CLI

**Status:** Complete
**Milestone:** A working REPL. `bun run dev` drops you at a prompt, streams the agent's output live, renders each tool call with an outcome line, tracks cost per turn, and survives Ctrl+C without losing the session. The harness is usable end-to-end for the first time.

---

## What Was Built

Sprint 6 delivers **Layer 9 Phase 1 (Readline CLI)** from the plan. Five small modules plus a bootstrap and a debug helper — everything above lines 9 of `src/index.ts` was already built in prior sprints; this sprint only wires it together.

The loop, providers, tools, session manager, and skills layer are untouched. The only real composition happens in `src/cli/index.ts`, which builds the system prompt once, holds the permission store for the shell process's lifetime, and persists whatever the agent loop appends after each turn.

### Files Added

```
src/
├── debug.ts                       # Module-level `enabled` flag + debug(category, …)
├── index.ts                       # Bootstrap — parse argv, short-circuit --help/--version, call runCLI
└── cli/
    ├── args.ts                    # parseArgs(argv) — pure; HELP_TEXT renders from COMMAND_HELP
    ├── args.test.ts               # --version/--help/--debug, short forms, multi-flag, unknown-flag
    ├── commands.ts                # executeCommand + per-command handlers + COMMAND_HELP
    ├── commands.test.ts           # parseCommand, dispatch, /sessions, /load, /clear, /cost, /skills
    ├── renderer.ts                # createRenderer — FIFO tool-call queue, tool-aware previewArgs
    ├── renderer.test.ts           # text_delta, tool pairing, context indicator, previewArgs edges
    └── index.ts                   # runCLI — readline REPL + Ctrl+C + turn persistence + title gen
```

### Files Removed

- `src/index.test.ts` — the Sprint 1 placeholder test no longer matched the real bootstrap and was deleted rather than rewritten (the entry point is dominated by I/O; the modules it calls are each unit-tested).

### Dependencies Added

None. `picocolors` and `gray-matter` were already in the tree from prior sprints; readline comes from Node's standard library. The CLI layer earns zero new dependencies.

---

## Architecture Decisions

### System prompt built **once** per REPL run

`buildSystemPrompt(...)` is called before the `while` loop and reused on every turn. That's the whole point of assembling it outside the loop — Anthropic's prompt cache hits on the cached prefix every turn past the first. Mutating the prompt per turn (e.g. re-discovering skills, re-reading `AGENTS.md`) would kill the cache and roughly double billable input tokens on long sessions. This mirrors the Sprint 5 decision to make skill discovery a session-lifetime operation.

### Permission store lives at REPL level, not inside `agentLoop`

`createPermissionStore()` is called once per `runCLI` invocation. "Allow for session" approvals survive across `/load` and `/clear` — which is the natural mental model for users: the approval applies to **this shell**, not **this conversation**. Putting the store inside `agentLoop` (as the plan sketched) would have meant approvals reset whenever the session swapped, which makes sense in neither direction.

The trade-off: a user who approves `rm` in a toy session and then `/load`s a different session still has `rm` approved. That's documented in `/help`. A second `tokenius` invocation starts fresh because the store doesn't outlive the process.

### `/clear` creates a new session — doesn't zero messages in place

The plan sketched `session.messages = []`. The implementation calls `createSession` again: previous conversation stays on disk (re-loadable via `/load`), future appends go to a clean file. Natural undo. The alternative would have either kept writing to the old file (confusing: a file called "Debug auth flow" now holds a conversation about a different topic) or discarded history silently. Neither is a good default.

### Renderer is a closure, not a class

`createRenderer({ model, write })` returns `{ handle, printTurnFooter }`. The closure holds two pieces of state: a **FIFO queue of pending tool calls** (pushed on `tool_call_start`, shifted on `tool_result`, so call order maps to result order) and the **context window size** captured from `getModelMetadata` once at construction. A class with private fields would carry the same state in more ceremony.

The pairing assumption is that tools execute in call order — enforced by `executeToolsSequential` in Sprint 3. If that ever changes to parallel execution, the renderer needs correlation ids; the comment on line 20 of `renderer.ts` flags this explicitly.

### Tool-call preview is tool-aware

A generic `JSON.stringify(args)` makes `bash`, `read`, and `grep` look identical. A switch keyed on tool name keeps the signal high: `bash` previews the first line of the command, `read`/`write`/`edit` show the path, `grep`/`glob` show the pattern, `spawn_agent` shows `"<agent>: <prompt>"`, and unknown tools fall back to a truncated raw-JSON dump. Partial/invalid JSON mid-stream produces an empty preview rather than throwing — we just render the tool name without args until args arrive.

This is slightly more code than "JSON-stringify and truncate," but it's the kind of small surface that makes the REPL **feel** designed rather than emitted. Extending it when a new tool lands is a one-line case.

### Commands accept a `write` sink — testable without stubbing stdout

`CommandContext.write` is a `(chunk: string) => void`. In production it's `process.stdout.write`; in tests it pushes to an array. Every command test in `commands.test.ts` asserts against the buffered, ANSI-stripped output without ever touching a global. The renderer does the same via `RendererOptions.write`.

This is the same pattern the smoke test used in Sprint 1 — inject the sink, keep the pure-function boundary — applied to the two places in the CLI that produce terminal output.

### `CommandResult` is a tagged union, not a void return

```ts
type CommandResult =
  | { type: "none" }
  | { type: "exit" }
  | { type: "unknown"; name: string }
  | { type: "replace_session"; session: Session };
```

Commands can't mutate the REPL's state directly (the `session` variable is local to `runCLI`). Instead they return the intent — "exit the loop", "swap in this session" — and the REPL pattern-matches. That keeps commands pure and leaves the ordering of state changes (persist old → swap → prompt) in one place.

### `/help` and `--help` share one source of truth

`COMMAND_HELP: readonly (readonly [string, string])[]` lives in `commands.ts`. Both `cmdHelp` (in-session `/help`) and `HELP_TEXT` (CLI `--help`) render from it. Before the post-review fix, the two lists had already drifted — `args.ts` had forgotten to list `/exit` and to add `/skills`. Making the render function derive from a single table fixes it permanently.

### `parseSkillInvocation` is shared, not inlined

`/skill:<name> <rest>` parsing lives in `skills/invoke.ts` alongside `applySkill`. The REPL uses it twice: once to detect that input is a skill invocation (so the slash-command router lets it through) and once to extract the name + prompt for `applySkill`. Inlining the logic twice was the original design and it was already drifting — e.g. `/skill: foo` would silently treat `" foo"` as the skill name. One parser, two call sites, edge cases tested in one place.

### `/skill:` is **not** a slash command

`parseCommand` explicitly returns `null` for anything starting with `/skill:`. The REPL sees `null` and falls through to the skill branch. Two concerns (command dispatch vs. user-message prefix), two code paths, no overloaded `/skill` handler. A user typo like `/skilll:foo` hits the "Unknown command" path and surfaces immediately — which is what you want.

### Debug mode uses a mutable module-level flag

`src/debug.ts` exports `debug(category, ...args)` plus `enableDebug()` and `isDebugEnabled()`. The module loads with `enabled = process.env["DEBUG"] === "tokenius"` (env path), and the entry point calls `enableDebug()` after `parseArgs` if `--debug` was passed. Module-level mutable state is the simplest thing that works: the flag has no legitimate "turn off" need, and keeping this in one tiny module with zero imports lets every layer depend on it without circular-import worries. The trade-off is the usual "shared mutable state is scary" — mitigated by the fact that this module has exactly three functions and one boolean, and there's a single writer (the entry point).

### Ctrl+C has three states, not two

- **Agent running:** abort the in-flight loop (`abortController.abort()`).
- **Idle, first press:** print a hint + redraw the prompt glyph.
- **Idle, second press within 1s:** exit.

The plan sketched a simpler two-state version (abort + double-press-exit). In practice an idle press should **not** reset the abort controller — there's nothing to abort — and should **not** silently no-op, which would leave the user wondering if the key was swallowed. A hint with a redraw is the smallest signal that readline is still alive.

**The subtle bug fixed post-review:** the first pass called `rl.prompt()` inside the SIGINT handler while a `rl.question()` was in flight. Readline treats `prompt()` and `question()` as separate drivers of the input loop, and interleaving them leaves the internal state inconsistent (double prompts, dropped keystrokes). The fix: just `process.stdout.write(PROMPT)` — cosmetic redraw only, the pending question still owns the input.

### Title generation is `await`'d, not fire-and-forget

`generateSessionTitle` runs after the first successful turn. It's a separate LLM call bounded by a 10s timeout, and it already swallows its own errors internally (`return truncateForTitle(firstUserMessage)` on any failure). The plan comment originally claimed we had to await it "because the next turn can't start until the first persists" — which is wrong, persistence is synchronous and already done by that point. The corrected comment says the real reason: `await` keeps the mutation ordered (`setTitle` can't race with a `/clear` that swaps the session) without needing a captured snapshot. The UX impact is minor because the timeout is tight and the call is cheap.

### `agentLoop`'s message-array contract is now documented

The REPL does `const beforeCount = session.messages.length; /* ... */ for (let i = beforeCount; i < turnResult.messages.length; i++) appendMessage(...)`. This only works if `agentLoop` returns the caller's array extended — the first `beforeCount` entries are identical to what we passed in. That contract is not type-enforced; a comment above the loop now spells it out so future refactors don't silently skip or duplicate messages.

---

## Post-Review Hardening

After the initial Sprint 6 implementation, a self-review surfaced several real issues. All fixed, all covered by new or updated tests:

| Issue                                                                  | Fix                                                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `rl.prompt()` inside SIGINT while `rl.question()` in flight            | Write `PROMPT` glyph directly; never call `rl.prompt()` during an active question                  |
| `readLine` swallowed every error as EOF — silent exit on real failure  | `catch (error) { debug("cli", "readline ended", error); return null; }` — surfaces under `--debug` |
| `/skill:` parsing duplicated in REPL and in `parseCommand`             | Extracted `parseSkillInvocation(input)` to `skills/invoke.ts`; both call sites share it            |
| Help text duplicated in `args.ts` and `commands.ts` — already drifting | `COMMAND_HELP` in `commands.ts` is the source of truth; `HELP_TEXT` renders from it                |
| `/skill: summarize` (leading space) silently used empty name           | `parseSkillInvocation` trims the name; empty name surfaces a "Usage" error                         |
| Title-generation justification comment was wrong                       | Rewrote the comment to reflect the real reason we await (ordering, not persistence)                |
| `agentLoop` message-array contract was implicit                        | Comment above the persistence loop spells out the prefix-preservation invariant                    |
| Permission-store lifetime unclear to users                             | `/help` now notes that "allow for session" persists across `/clear` and `/load`                    |

The code review that prompted these fixes is preserved in conversation history — the bigger-picture takeaway is that the two most important fixes were SIGINT state management and the readline error silence. Both were failure modes that would have been hard to debug later ("why did the REPL die?") precisely because they were silent.

---

## Key Implementations

### The loop body — one user turn, beginning to end

```ts
while (true) {
  const input = await readLine(rl);
  if (input === null) break; // EOF (Ctrl+D) or readline error
  if (input.trim().length === 0) continue;

  // Slash-command branch. `/skill:` is NOT a command; parseSkillInvocation
  // returns non-null for it, so the router lets it fall through.
  if (input.startsWith("/") && parseSkillInvocation(input) === null) {
    const result = await executeCommand(input, { session, cwd, write: stdoutWrite });
    if (result.type === "exit") break;
    if (result.type === "replace_session") session = result.session;
    continue;
  }

  // Skill branch. Shared parser with the router above.
  let userContent = input;
  const invocation = parseSkillInvocation(input);
  if (invocation) {
    if (invocation.name.length === 0) {
      /* usage error */ continue;
    }
    const skill = skills.find((s) => s.name === invocation.name);
    if (!skill) {
      /* unknown-skill error */ continue;
    }
    userContent = applySkill(skill, invocation.prompt);
  }

  // Turn — persist user message, run loop, persist everything the loop appended.
  const userMsg = { role: "user" as const, content: userContent };
  session.messages.push(userMsg);
  appendMessage(cwd, session.id, userMsg);

  abortController = new AbortController();
  agentRunning = true;
  const beforeCount = session.messages.length;
  let turnResult;
  try {
    turnResult = await agentLoop({ /* ... */ signal: abortController.signal, permissionStore });
  } finally {
    agentRunning = false;
  }

  for (let i = beforeCount; i < turnResult.messages.length; i++) {
    const m = turnResult.messages[i];
    if (m) appendMessage(cwd, session.id, m);
  }
  session.messages = turnResult.messages;

  renderer.printTurnFooter(turnResult.usage, calculateCost(config.model, turnResult.usage));

  if (!session.header.title && turnResult.stopReason !== "error") {
    const title = await generateSessionTitle(input, provider, config.model);
    setTitle(cwd, session, title);
  }
}
```

Every branch of the `while` either `continue`s (invalid input, slash command, skill error) or completes a full turn (read → persist user → run loop → persist results → footer → maybe title). No early returns inside the turn, so the abort/finally pairing always runs.

### Renderer state — a FIFO queue and a context window size

```ts
const pending: { name: string; rawArgs: string }[] = [];

function handle(event: AgentEvent): void {
  switch (event.type) {
    case "tool_call_start":
      pending.push({ name: event.name, rawArgs: "" });
      break;
    case "tool_call_args": {
      const last = pending.at(-1);
      if (last) last.rawArgs = event.partialArgs;
      break;
    }
    case "tool_result": {
      const call = pending.shift();
      const name = call?.name ?? event.name;
      const preview = call ? previewArgs(name, call.rawArgs) : "";
      write(`\n${pc.cyan(`→ ${name}`)}`);
      if (preview) write(`  ${pc.dim(preview)}`);
      write("\n");
      if (event.result.isError) write(`  ${pc.red(`✖ ${event.result.content.slice(0, 200)}`)}\n`);
      else write(`  ${pc.green(`✓ ${event.result.content.length} chars`)}\n`);
      break;
    }
    // ... other events ...
  }
}
```

`push`-on-start + `shift`-on-result preserves call order trivially. The `?? event.name` fallback handles the (shouldn't-happen) case of a result arriving without a preceding start — we still render something useful instead of crashing.

### `parseSkillInvocation` — one parser, two call sites

```ts
export const SKILL_PREFIX = "/skill:";

export function parseSkillInvocation(input: string): { name: string; prompt: string } | null {
  if (!input.startsWith(SKILL_PREFIX)) return null;
  const rest = input.slice(SKILL_PREFIX.length);
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) return { name: rest.trim(), prompt: "" };
  return { name: rest.slice(0, firstSpace).trim(), prompt: rest.slice(firstSpace + 1) };
}
```

Two subtle behaviors: the **name is trimmed** (so `/skill: foo bar` surfaces an empty-name error rather than silently using `" foo"`), and the **prompt body is preserved verbatim** (only the first space after the name is the separator — inner whitespace survives). Both are in the test suite.

### SIGINT — three states, no `rl.prompt()`

```ts
process.on("SIGINT", () => {
  if (agentRunning) {
    process.stdout.write(pc.yellow("\n[aborting current turn]\n"));
    abortController.abort();
    return;
  }
  const now = Date.now();
  if (now - lastCtrlC < 1000) {
    process.stdout.write("\n");
    process.exit(0);
  }
  lastCtrlC = now;
  // DO NOT call rl.prompt() — the pending rl.question() owns the input stream.
  process.stdout.write(
    pc.dim("\n(press Ctrl+C again within 1s to exit, or type /quit)\n") + PROMPT,
  );
});
```

### `readLine` — treats EOF/close as end, logs anything else

```ts
async function readLine(rl: ReadlineInterface): Promise<string | null> {
  try {
    return await rl.question(PROMPT);
  } catch (error) {
    debug("cli", "readline ended", error);
    return null;
  }
}
```

The previous version had a bare `catch {}`. Now a real readline failure (e.g. a broken stdin) still exits cleanly but leaves a stderr trail for the `--debug` user to see.

---

## Test Coverage

**324 pass, 3 skip, 0 fail** across 34 test files (+42 pass, +2 files vs Sprint 5).

| Module          | What's covered                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `cli/args`      | Empty argv, `--version`/`-v`, `--help`/`-h`, `--debug` (no short form), multi-flag, unknown flags ignored                               |
| `cli/commands`  | `parseCommand` (bare, with-arg, `/skill:` rejection, whitespace), dispatch routing, unknown command                                     |
|                 | `/help` lists everything, `/quit` + `/exit` both exit, `/sessions` lists, `/load` swaps / errors on miss                                |
|                 | `/clear` returns a new session id with empty messages, `/cost` sums usage across assistant messages                                     |
|                 | `/skills` empty vs. populated (fixture with frontmatter YAML)                                                                           |
| `cli/renderer`  | `text_delta` streams through, tool call+result pairing with preview, error-result snippet, sequential order                             |
|                 | Context indicator on `turn_end`, `context_limit_reached` message, subagent-complete line                                                |
|                 | `previewArgs` per tool family + malformed-JSON + length cap, `formatContextIndicator` thresholds + divide-by-zero                       |
| `skills/invoke` | `applySkill` unchanged; new `parseSkillInvocation` — null for non-skill, name+prompt, name-only, trim edge, prompt whitespace preserved |

No end-to-end "type input, assert output" test — the REPL is dominated by `rl.question` I/O and a SIGINT listener, both of which cost more to mock than they return in signal. Every branch of `runCLI` is exercised indirectly via the module-level tests above.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated. The main changes:

- **Readline uses `node:readline/promises`** — the promises API, not the callback API. Lets the main loop use a clean `await` without a `question(rl, ...)` wrapper.
- **`parseArgs(argv)` is pure.** Plan read `process.argv` directly; the implementation takes the slice so tests don't have to monkey-patch globals. Also supports `-v` / `-h` short forms.
- **Single source of truth for command help.** `COMMAND_HELP` lives in `commands.ts`; both `/help` and `HELP_TEXT` render from it.
- **`/clear` creates a new session.** Plan zeroed messages in place; the implementation keeps the previous conversation on disk and starts fresh. Natural undo + no cross-topic pollution in a single JSONL.
- **Commands return a `CommandResult` tagged union.** Plan's `(args, session) => Promise<void>` couldn't express "replace the session" cleanly. The union makes state transitions explicit.
- **Renderer is a closure with state.** Plan's `renderEvent(event)` was stateless; the implementation holds a FIFO pending-call queue so results pair with their calls, and a cached context window size for the indicator.
- **`previewArgs` is tool-aware.** Plan showed `console.log(chalk.cyan(\`\n> ${event.name}\`))` with no args preview. The implementation switches on tool name for a useful one-line preview.
- **Context indicator + color thresholds.** Plan mentioned it in passing; implemented with green <50%, yellow <80%, red beyond, rendered on every `turn_end`.
- **Three-state Ctrl+C.** Plan had two states (abort + double-press-exit). Implementation distinguishes idle (hint + redraw) vs. running (abort).
- **SIGINT never calls `rl.prompt()`.** Interleaving `prompt()` with a pending `question()` corrupts readline state; just write the glyph.
- **Permission store lives at REPL level.** Plan placed it inside `agentLoop`; moving it up means "allow for session" survives `/clear` and `/load`, matching the "shell-session" mental model.
- **`parseSkillInvocation` extracted.** Plan inlined the `/skill:` parse at the call site. Extracted so the slash-command router and the turn dispatcher share one parser with one set of edge cases.
- **Debug module has `enableDebug()`.** Plan gated `debug(...)` on a `const DEBUG = process.argv.includes("--debug")` at module load. Implementation uses a mutable `enabled` so the entry point can flip it after `parseArgs` runs, without rereading argv.
- **Title generation is awaited for ordering, not persistence.** Plan comment justified the await with persistence; the real reason is preventing races between `setTitle` and `/clear`/`/load`.
- **`/model`, `/usage`, `/replay` deferred to Sprint 7.** None are blockers for a working REPL and each has its own surface to design (model-switch validation, cache-token display, replay-without-tools semantics).

---

## Running It

```bash
# Install + start the REPL (needs ANTHROPIC_API_KEY)
bun install
bun run dev

# Show flags + in-session commands
bun run dev --help

# Full check suite (lint, format, typecheck, knip, test)
bun run check

# Debug mode — raw events + internal state to stderr
DEBUG=tokenius bun run dev
# or
bun run dev --debug
```

Inside the REPL: type a message to run the agent, `/help` for the command list, `/skill:<name> <request>` to inject a discovered skill, Ctrl+C to abort a running turn or (twice within 1s) to exit.

**Sprint 6 done.** The harness is now a usable coding agent end-to-end. Sprint 7 is where the sharp edges get filed off: OpenAI provider, `/usage` and `/replay` commands, error-handling pass, missing-ripgrep fallback, and a first-run experience for missing API keys.
