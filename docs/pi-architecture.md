# Coding Agent / Harness Architecture Research

Research notes from exploring [badlogic/pi-mono](https://github.com/badlogic/pi-mono) — a TypeScript monorepo implementing a full coding agent (CLI + TUI + RPC + web). Built by Mario Zechner.

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Layer 1: LLM Provider Abstraction](#layer-1-llm-provider-abstraction)
3. [Layer 2: Agent Loop](#layer-2-agent-loop-the-core-algorithm)
4. [Layer 3: Tool System](#layer-3-tool-system)
5. [Layer 4: Extension System](#layer-4-extension-system)
6. [Layer 5: Session Management & Persistence](#layer-5-session-management--persistence)
7. [Layer 6: Context Compaction](#layer-6-context-compaction)
8. [Layer 7: CLI Modes & Transports](#layer-7-cli-modes--transports)
9. [Key Patterns & Takeaways](#key-patterns--takeaways)
10. [Tech Stack Reference](#tech-stack-reference)

---

## High-Level Architecture

```
┌─────────────────────────────────────────┐
│           CLI / TUI / RPC               │  ← Layer 7: User interface
├─────────────────────────────────────────┤
│        Session Manager (JSONL)          │  ← Layer 5-6: Persistence + compaction
├─────────────────────────────────────────┤
│    Agent Session (state + queuing)      │  ← Glue: config, model cycling, retry
├─────────────────────────────────────────┤
│         Extension System                │  ← Layer 4: Plugins, hooks, commands
├─────────────────────────────────────────┤
│     Agent Loop (inner + outer)          │  ← Layer 2: The core algorithm
├─────────────────────────────────────────┤
│    Tool Registry + Execution            │  ← Layer 3: Schema, execute, truncate
├─────────────────────────────────────────┤
│    LLM Provider Abstraction             │  ← Layer 1: Unified streaming API
└─────────────────────────────────────────┘
```

### Monorepo Package Structure

| Package           | Purpose                                                                              |
| ----------------- | ------------------------------------------------------------------------------------ |
| `pi-ai`           | Unified LLM provider abstraction (Anthropic, OpenAI, Google, Mistral, Bedrock, etc.) |
| `pi-agent-core`   | Stateful agent loop — tool execution, steering, events, message management           |
| `pi-coding-agent` | The actual CLI/TUI coding agent (interactive, print, JSON, RPC modes)                |
| `pi-tui`          | Custom terminal UI framework with differential rendering                             |
| `pi-web-ui`       | Web chat interface using web components (mini-lit)                                   |
| `pi-mom`          | Slack bot powered by the agent                                                       |
| `pi-pods`         | GPU pod management for self-hosted vLLM                                              |

### Design Philosophy

- **Minimal core, extensible everything** — no MCP built-in, no sub-agents built-in, no permission popups by default
- **No magic** — run in containers for sandboxing, use tmux for background tasks
- **Extensibility first** — every feature should be replaceable
- **Separate packages per layer** — enforces clean boundaries, each layer independently testable

---

## Layer 1: LLM Provider Abstraction

The foundation. A unified interface over multiple LLM providers.

### Unified Stream Function

Every provider implements a single function signature:

```typescript
type StreamFunction<TApi, TOptions> = (
  model: Model<TApi>,
  context: Context,
  options?: TOptions,
) => AssistantMessageEventStream;
```

### Streaming Event Types (Discriminated Union)

```typescript
type AssistantMessageEvent =
  | { type: "start"; message: Partial<AssistantMessage> }
  | { type: "text_start"; index: number }
  | { type: "text_delta"; index: number; text: string }
  | { type: "text_end"; index: number }
  | { type: "thinking_start"; index: number }
  | { type: "thinking_delta"; index: number; thinking: string }
  | { type: "thinking_end"; index: number }
  | { type: "toolcall_start"; index: number; id: string; name: string }
  | { type: "toolcall_delta"; index: number; arguments: string }
  | { type: "toolcall_end"; index: number }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: Error };
```

### Message Types

```typescript
type UserMessage = {
  role: "user";
  content: (TextContent | ImageContent)[];
  timestamp?: number;
};

type AssistantMessage = {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
  stopReason: "stop" | "length" | "toolUse";
  provider?: string;
};

type ToolResultMessage = {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: Record<string, unknown>;
  error?: boolean;
};
```

### Provider Registry Pattern

Providers register via a Map-based registry. Dynamic loading + type safety through generics:

```typescript
registerApiProvider({
  api: "anthropic-messages",
  stream: streamAnthropic,
  streamSimple: streamSimpleAnthropic,
});
```

Each provider normalizes its SDK output to the common event types:

- **Anthropic:** maps `effort` levels (low/medium/high/max)
- **OpenAI:** maps `reasoning_effort` (low/medium/high)
- **Google:** maps `thinkingBudgetTokens` (scaled by model)
- All hidden behind a single `ThinkingLevel` enum: `"minimal" | "low" | "medium" | "high" | "xhigh"`

### Partial JSON Parsing for Streaming Tool Arguments

Tool call arguments stream incrementally. Accumulate `toolcall_delta` strings and parse progressively with a fallback parser for incomplete JSON:

```typescript
function parseStreamingJson<T>(incomplete: string | undefined): T {
  if (!incomplete) return {} as T;
  try {
    return JSON.parse(incomplete) as T;
  } catch {
    try {
      return partialJsonParse(incomplete) as T; // Handles incomplete JSON
    } catch {
      return {} as T;
    }
  }
}
```

### Token Tracking & Cost Calculation

Every `AssistantMessage` includes `usage`. Combined with a model registry storing per-token costs:

```typescript
function calculateCost(model, usage): number {
  return (
    (usage.inputTokens * model.costs.input) / 1_000_000 +
    (usage.outputTokens * model.costs.output) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * model.costs.cacheRead) / 1_000_000 +
    ((usage.cacheWriteTokens ?? 0) * model.costs.cacheWrite) / 1_000_000
  );
}
```

### Event Stream Implementation

Uses a **queue-and-waiter pattern** for non-blocking event emission:

```typescript
class EventStream<T, R> {
  private queue: T[] = [];
  private waiters: Array<() => void> = [];

  push(event: T): void {
    if (this.waiters.length > 0) {
      this.waiters.shift()?.();
    } else {
      this.queue.push(event);
    }
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length > 0) yield this.queue.shift()!;
      else await new Promise((resolve) => this.waiters.push(resolve));
      if (this.done) break;
    }
  }
}
```

### Context Overflow Detection

Maintains regex patterns for 20+ providers to detect overflow:

```typescript
const patterns = [
  /prompt is too long/i, // Anthropic
  /max_tokens/i, // OpenAI
  /exceeds maximum context length/i, // Google
  /context_length_exceeded/i, // Others
];
```

### Testing with Mock Provider

Faux provider for unit tests without real API calls:

```typescript
registerFauxProvider();
setResponses([
  fauxAssistantMessage({
    content: [fauxText("Hello!"), fauxToolCall("calculator", { expression: "2+2" })],
  }),
]);
```

---

## Layer 2: Agent Loop (The Core Algorithm)

The heart of the agent. Two entry points:

```typescript
agentLoop(prompts, context, config, signal?, streamFn?)      // New prompt
agentLoopContinue(context, config, signal?, streamFn?)        // Continue existing
```

### Two Nested Loops

```
OUTER LOOP (follow-ups):
  while follow-up messages exist:

    INNER LOOP (tool execution):
      while tool calls exist OR steering messages pending:
        1. Inject any steering messages
        2. Call LLM (stream response)
        3. If error/abort → exit immediately
        4. Extract tool calls from response
        5. Execute tools (parallel or sequential)
        6. Add tool results to context
        7. Check for new steering messages

    Check for follow-up messages → continue outer loop
```

**Stop condition:** No tool calls AND no steering AND no follow-ups.

### LLM Call: `streamAssistantResponse()`

This is the **only place** where `AgentMessage[]` transforms to `Message[]` for the LLM:

1. Apply `transformContext` (AgentMessage[] → AgentMessage[]) — allows pruning/injecting
2. Call `convertToLlm` (AgentMessage[] → Message[]) — strips custom types
3. Build LLM context with system prompt + tools
4. Resolve API key (fresh each turn, important for expiring tokens)
5. Call stream function
6. Handle streaming events — **partial message is added to `context.messages` immediately on `start`**, then updated in-place for each delta

### Parallel Tool Execution (Default) — 3-Phase Approach

```typescript
// Phase 1: SEQUENTIAL PREPARATION
for (const toolCall of toolCalls) {
  // Validate args, call beforeToolCall hook, check for blocks
  // Blocked tools → immediate error result
  // Approved tools → add to runnable list
}

// Phase 2: CONCURRENT EXECUTION
const runningCalls = runnableCalls.map(prepared => ({
  prepared,
  execution: executePreparedToolCall(prepared, signal, emit)
}));

// Phase 3: SEQUENTIAL FINALIZATION (maintains order)
for (const running of runningCalls) {
  const executed = await running.execution;
  results.push(await finalizeExecutedToolCall(...));
}
```

### Sequential Tool Execution

One at a time: Prepare → Execute → Finalize → next tool.

### Tool Preparation Pipeline

1. **Find tool by name** — if not found, return error immediately
2. **Apply `prepareArguments` shim** — optional compatibility layer for schema evolution
3. **Validate against schema** (TypeBox + AJV) — throws on validation failure
4. **Call `beforeToolCall` hook** — can block execution with `{ block: true, reason }`

### Tool Execution with Progress Callback

```typescript
const result = await tool.execute(
  toolCallId,
  validatedArgs,
  signal,                    // AbortSignal for cancellation
  (partialResult) => {       // Streaming progress updates
    emit({ type: "tool_execution_update", ... });
  }
);
```

### Hook System

- **`beforeToolCall(context)`** → return `{ block: true, reason }` to prevent execution
- **`afterToolCall(context)`** → field-by-field replacement of result (NOT deep merge)
- **`transformContext(messages)`** → prune/inject messages before LLM call
- **`getSteeringMessages()`** → inject high-priority messages between turns
- **`getFollowUpMessages()`** → inject low-priority messages when agent would stop

### Event Emission Order

```
agent_start
  → turn_start
    → message_start → message_update* → message_end
    → tool_execution_start → tool_execution_update* → tool_execution_end
  → turn_end
agent_end
```

Events always emitted in order. Subscribers awaited in registration order.

### Error Handling

- **LLM errors** (stopReason: "error" | "aborted") → exit immediately
- **Tool execution errors** → NOT fatal, become `ToolResultMessage` with `isError: true`, loop continues
- **Abort signals** flow through entire execution tree (LLM stream, tool prep, tool execution, hooks)

---

## Layer 3: Tool System

### Tool Definition Interface

```typescript
interface AgentTool<TParameters, TDetails> {
  name: string; // Unique ID used by LLM
  label: string; // Human-readable display
  description: string; // Shown to LLM in system prompt
  promptSnippet?: string; // Brief description for prompts
  promptGuidelines?: string[]; // Best-practice instructions
  parameters: TSchema; // TypeBox schema
  prepareArguments?: (args: unknown) => Static<TParameters>; // Legacy compat
  execute: (
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ) => Promise<AgentToolResult<TDetails>>;
  renderCall?(args, theme, context); // Custom TUI visualization
  renderResult?(result, options, theme, context); // Custom result display
}
```

### Tool Result Format

```typescript
{
  content: Array<{ type: "text", text: string } | { type: "image", data: string }>,
  details?: Record<string, any>,  // Structured metadata, survives branching
  isError?: boolean
}
```

### 7 Built-in Tools

**Coding tools (read/write):**

- `read` — File reading with offset/limit, image detection, auto-resize (2000x2000)
- `write` — Create/overwrite files (creates parent dirs)
- `edit` — Unified diff-based editing (line ranges or full files)
- `bash` — Shell command execution with streaming output, timeout, process tree killing

**Read-only tools (exploration):**

- `grep` — Pattern search with context (via ripgrep)
- `find` — Glob-based file discovery (via fd)
- `ls` — Directory listing with stat information

### Output Truncation (Mandatory)

Dual limits — whichever hits first:

- **DEFAULT_MAX_LINES:** 2,000 lines
- **DEFAULT_MAX_BYTES:** 50KB

Two strategies:

- **`truncateHead()`** — keeps beginning (file reads, search results)
- **`truncateTail()`** — keeps end (bash output, error messages at bottom)

Never produces partial lines. Returns truncation metadata for the LLM to act on.

### Bash Tool — Dual Buffer Strategy

- In-memory rolling buffer for recent output
- Switches to temp file when > DEFAULT_MAX_BYTES
- Streams partial results via `onUpdate()` callback
- Process tree killing on timeout/abort

### File Mutation Queue

Prevents race conditions on concurrent writes:

```typescript
function withFileMutationQueue(filePath, operation) {
  // 1. Resolve to canonical path
  // 2. Maintain per-file promise queue
  // 3. Each operation awaits previous queue
  // 4. Different files run in parallel
  // 5. Clean up empty queues after completion
}
```

### Pluggable Operations Pattern

All file tools accept a custom backend:

```typescript
interface ReadOperations {
  readFile(path: string): Promise<string | Buffer>;
  stat(path: string): Promise<Stats>;
  exists(path: string): Promise<boolean>;
}

const readTool = createReadTool({
  operations: sshBackend, // Swap in SSH, S3, containers, etc.
});
```

### Tool Factory Pattern

```typescript
const tools = createAllToolDefinitions("/home/user/project");
// Or individual:
const readTool = createReadTool({ cwd, autoResizeImages: true });
```

---

## Layer 4: Extension System

### Extension = Plugin Factory

```typescript
export default function(pi: ExtensionAPI) {
  pi.registerTool({ ... });              // Add/replace tools
  pi.registerCommand("cmd", { ... });    // Slash commands
  pi.on("tool_call", handler);           // Intercept execution
  pi.on("tool_result", handler);         // Transform results
  pi.on("session_start", handler);       // Lifecycle hooks
}
```

### Loading Order

1. Project-local: `.pi/extensions/` in cwd
2. Global: `~/.pi/agent/extensions/`
3. Configured paths in `settings.json`

Uses jiti for TypeScript loading. Subdirectories with `index.ts` or `package.json` are scanned.

### Event Flow

```
session_start → resources_discover → [waiting for input]
user input → input → before_agent_start → agent_start
  → turn_start → context → before_provider_request
    → message_start/update/end
    → tool_call → tool_execution_start/update/end → tool_result
  → turn_end
→ agent_end → [waiting for input]
session_before_switch → session_shutdown → session_start
session_before_fork → [branch created]
```

### Handler Execution Model

Handlers execute synchronously through extensions:

- Awaited in subscription order
- Can **short-circuit** with `{ block: true }`
- Can **chain transformations** by modifying event data
- Errors logged, then continue to next handler

### Permission Gates Example

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "bash" && /rm -rf/.test(event.input.command)) {
    const ok = await ctx.ui.confirm("Allow dangerous command?");
    if (!ok) return { block: true, reason: "User denied" };
  }
});
```

### State Persistence for Extensions

Extensions store state via session entries:

```typescript
// Save state
pi.appendEntry("my-extension-state", { data: "survives branching" });

// Reconstruct on load
pi.on("session_start", async (event, ctx) => {
  for (const entry of ctx.sessionManager.getEntries()) {
    if (entry.customType === "my-extension-state") {
      restoreState(entry.data);
    }
  }
});
```

### Tool Override

Extensions can replace built-in tools by registering a tool with the same name:

```typescript
pi.registerTool({
  name: "read",  // Same name as built-in → replaces it
  description: "Enhanced read with caching",
  parameters: Type.Object({ path: Type.String() }),
  async execute(id, params, signal, onUpdate, ctx) { ... }
});
```

### Extension Context API

```typescript
interface ExtensionContext {
  // UI
  ui: {
    select(label, choices): Promise<string>;
    confirm(title, message): Promise<boolean>;
    input(prompt): Promise<string>;
    notify(message, type): void;
    setStatus(id, text): void;
  };

  // Control
  abort(): void;
  compact(): void;
  getContextUsage(): { used: number; max: number };

  // Metadata
  cwd: string;
  hasUI: boolean;
  signal: AbortSignal;
}
```

### Skills System

Skills are **README-driven capabilities** that pre-load specialized instructions:

```
~/.pi/agent/skills/
  react-migration/
    SKILL.md          # Frontmatter + instructions
    example-code.tsx  # Supporting files
```

SKILL.md format:

```markdown
---
name: react-migration
description: "Guide through React migration strategies"
---

# React Migration Assistant

You are an expert at migrating legacy React codebases...
```

Discovery at startup → registered as XML in system prompt → lazy-loaded when invoked via `/skill:name`.

---

## Layer 5: Session Management & Persistence

### Core Concept: Append-Only JSONL Tree

Sessions stored as JSONL files. Each line = JSON entry. Entries form a DAG using `id` + `parentId` fields. **Branching without file duplication.**

### Session Header (First Line)

```json
{
  "type": "session",
  "version": 3,
  "id": "unique-session-id",
  "timestamp": "2025-04-13T10:00:00Z",
  "cwd": "/path/to/working/directory",
  "parentSession": "path-to-parent.jsonl"
}
```

### Entry Types

| Type                    | Purpose                                                     |
| ----------------------- | ----------------------------------------------------------- |
| `message`               | User/assistant messages with content, tool use, usage stats |
| `compaction`            | Summarized history with `firstKeptEntryId` + `summary`      |
| `model-change`          | When model switches                                         |
| `thinking-level-change` | When reasoning depth adjusts                                |
| `branch-summary`        | Context snapshot when abandoning a path                     |
| `custom`                | Extension data (NOT in LLM context)                         |
| `custom-message`        | Extension-injected LLM messages                             |
| `label`                 | User-defined bookmarks                                      |
| `session-info`          | Metadata like display names                                 |

### Base Entry Structure

```typescript
{
  type: string,
  id: string,        // 8 hex chars
  parentId: string | null,
  timestamp: string  // ISO-8601
}
```

### Context Building (`buildSessionContext()`)

1. Walk from current leaf → root via `parentId` chain
2. Collect all entries along path
3. Handle compaction: emit summary + kept messages + post-compaction entries
4. Filter to message types (ignore model/thinking changes)
5. Return resolved array for LLM context

### Branching

Move the leaf pointer to an earlier entry. New messages become children of that entry — a new branch in the tree. No file duplication needed.

```typescript
branch(entryId); // Move leaf to earlier entry
branchWithSummary(entryId, summary); // Add context before branch
createBranchedSession(fromId, toId); // Export linear path to new file
```

### Schema Migrations

Auto-upgrade: v1→v2 (tree structure) → v2→v3 (custom role)

---

## Layer 6: Context Compaction

### Token Budget Defaults

- **Reserve tokens:** 16,384 (system prompt + response space)
- **Keep recent:** 20,000 tokens of recent context
- **Trigger:** compact when `totalTokens > contextWindow - reserveTokens`

### Cut Point Detection Algorithm

1. Iterate backward from current leaf
2. Sum estimated message sizes
3. Stop when accumulated >= `keepRecentTokens`
4. Find nearest valid cut point — **never mid-tool-result** (must stay paired with tool calls)
5. If cutting mid-turn, prepare split summarization

### Two-Phase Summarization

**Phase 1: History Summary** (for discarded messages)

- Structured format: Goal, Constraints, Progress, Key Decisions, Next Steps, Critical Context

**Phase 2: Turn Prefix Summary** (if splitting a turn)

- Concise summary of prefix context for retained suffix

### Incremental Updates

Previous summary fed into new compaction generation — accumulated knowledge preserved across cycles.

### File Operations Tracking

```typescript
extractFileOpsFromMessage(message) → {
  read: string[],      // Files accessed
  written: string[],   // Files created
  edited: string[]     // Files modified
}
```

Tracked across tool calls and previous compaction metadata, embedded in summaries for continuity.

### Branch Summarization

When branching away from current path:

1. Collect entries from common ancestor to current position
2. Convert to messages, respect token budgets
3. LLM generates structured summary (Goal, Progress, Decisions, Next Steps)

---

## Layer 7: CLI Modes & Transports

### Four Modes Sharing One `AgentSession` Core

| Mode                 | Use Case         | I/O                                       |
| -------------------- | ---------------- | ----------------------------------------- |
| Interactive (TUI)    | Daily use        | Terminal with editor, streaming, themes   |
| Print (`-p`)         | Scripts, pipes   | stdin → stdout, exit code                 |
| JSON (`--mode json`) | Integrations     | JSONL events on stdout                    |
| RPC (`--mode rpc`)   | Non-Node clients | JSONL commands on stdin, events on stdout |

### Mode Resolution Priority

```
1. --rpc flag    → RPC mode
2. --json flag   → JSON mode
3. --print flag OR non-TTY stdin → Print mode
4. TTY stdin     → Interactive mode
```

### RPC Protocol

**JSONL framing** — one JSON object per line, delimited by LF.

**Commands** (stdin):

```json
{ "id": "req-1", "type": "prompt", "message": "Hello" }
{ "id": "req-2", "type": "set_model", "model": "claude-opus-4-6" }
{ "type": "abort" }
```

**Responses** (stdout):

```json
{ "id": "req-1", "type": "response", "command": "prompt", "success": true }
```

**Events** (stdout, async):

```json
{ "type": "message_start", ... }
{ "type": "tool_call", ... }
{ "type": "message_end", ... }
```

**Command categories:** prompt/steer/follow_up/abort, get_state/get_messages, set_model/cycle_model/set_thinking_level, fork/switch_session/export_html, bash/compaction/retry

**RPC Client** for programmatic access:

```typescript
const client = new RpcClient(agentPath, cwd);
await client.start();
await client.prompt("How many files?");
client.onMessage(msg => ...);
await client.stop();
```

Custom JSONL parser (avoids Node's `readline` which breaks on U+2028/U+2029 unicode separators that are valid in JSON).

### Message Queuing During Streaming

```typescript
_steeringMessages; // High-priority, executes after tool calls
_followUpMessages; // Low-priority, executes when idle
_pendingBashMessages; // Bash results deferred until turn ends
_pendingNextTurnMessages; // Custom messages for next prompt
```

### Auto-Retry Logic

Retryable patterns trigger exponential backoff:

- Rate limits (429)
- Server errors (5xx)
- Network timeouts
- Context overflow (triggers compaction first, then retry)

---

## Key Patterns & Takeaways

### Architecture Patterns

| Pattern                        | Purpose                 | Implementation                                       |
| ------------------------------ | ----------------------- | ---------------------------------------------------- |
| **Provider Registry**          | Multi-LLM support       | Map-based registry with generic type safety          |
| **Event Stream**               | Non-blocking streaming  | Queue-and-waiter async iterator                      |
| **Two Nested Loops**           | Agent control flow      | Outer (follow-ups) + inner (tool execution)          |
| **3-Phase Parallel Execution** | Safe concurrent tools   | Preflight → concurrent execute → sequential finalize |
| **Hook System**                | Extensible control      | beforeToolCall/afterToolCall/transformContext        |
| **Append-Only JSONL Tree**     | Session persistence     | id+parentId DAG, branching without duplication       |
| **Cut Point Detection**        | Smart compaction        | Never cut mid-tool-result, structured summaries      |
| **Extension Factory**          | Plugin loading          | Default export factory, jiti TypeScript loader       |
| **File Mutation Queue**        | Concurrent write safety | Per-file promise chain serialization                 |
| **Pluggable Operations**       | Backend abstraction     | Interface injection for SSH/S3/container backends    |

### Critical Design Decisions

1. **Streaming updates context in-place** — partial AssistantMessage pushed to `context.messages` on start, updated for each delta
2. **Tool errors are non-fatal** — become ToolResultMessage with isError:true, loop continues
3. **LLM errors are fatal** — stopReason "error"/"aborted" exits immediately
4. **Events always in order** — subscribers awaited in registration order, deterministic
5. **Output truncation is mandatory** — dual limits (lines + bytes), metadata tells LLM how to continue
6. **Context is fully serializable** — JSON in/out, enables provider switching mid-conversation
7. **API keys resolved per-turn** — supports expiring tokens, OAuth refresh
8. **Extensions can replace built-ins** — same-name tool registration overrides

### Build Order (Bottom-Up)

If building from scratch:

1. **LLM abstraction** — unified stream function, event types, provider registry
2. **Tool definitions** — schema, execute, result format, truncation
3. **Agent loop** — inner/outer loops, tool execution, hooks
4. **Session persistence** — JSONL tree, context building, compaction
5. **CLI/transport** — interactive, print, RPC modes

---

## Tech Stack Reference

### Core

- **Language:** TypeScript (96% of codebase)
- **Runtime:** Node.js v20+
- **Build:** tsgo (TS compiler wrapper), bun (binary builds)
- **Linter:** Biome
- **Testing:** Vitest with faux provider (no real API calls)

### LLM SDKs

- `@anthropic-ai/sdk` ^0.73.0
- `openai` 6.26.0
- `@google/genai` ^1.40.0
- `@mistralai/mistralai` 1.14.1
- `@aws-sdk/client-bedrock-runtime` ^3.983.0

### Schema & Validation

- `@sinclair/typebox` — schema definition
- `ajv` + `ajv-formats` — JSON schema validation
- `zod-to-json-schema` — Zod to JSON schema conversion

### UI & Rendering

- Custom TUI framework (`pi-tui`) with CSI 2026 synchronized output
- `mini-lit` web components for browser UI
- Tailwind CSS v4 for web styling
- `chalk`, `cli-highlight`, `marked` for CLI formatting

### Utilities

- `undici`, `proxy-agent` — HTTP with proxy support
- `diff` — unified diff for edit tool
- `proper-lockfile` — file locking
- `@silvia-odwyer/photon-node` — image processing/resize
- `glob`, `ignore` — file pattern matching

---

## Other Agents/Harnesses to Research

> [?] Compare patterns with:
>
> - Claude Code (Anthropic's official CLI)
> - Aider (Paul Gauthier)
> - Cline (VS Code extension)
> - OpenHands / SWE-agent
> - Goose (Block)
> - Cursor's agent mode internals
