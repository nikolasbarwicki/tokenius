# Tokenius — Technical Architecture v3

A lightweight, well-designed coding agent harness. Single-process TypeScript + Bun.

**Revision notes (v3):** Expanded from v2 with full roadmap coverage. Added: testing strategy,
partial JSON parser (explicit), observability & debug mode, CI/CD & distribution, documentation
& portfolio plan. Reorganized implementation order — security now wired into tools as they're
built (security-by-design), not retroactively. Added DX polish items.

**Revision notes (v2):** Incorporates all decisions from the design review session.
Removed: compaction, parallel tool execution, file locks, bash streaming, API keys in config.
Added: hard context limit, retry with backoff, prompt caching design, real token tracking.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [System Architecture](#system-architecture)
3. [Layer 1: LLM Provider Abstraction](#layer-1-llm-provider-abstraction)
4. [Layer 2: Tool System](#layer-2-tool-system)
5. [Layer 3: Agent Loop](#layer-3-agent-loop)
6. [Layer 4: Agents & Subagents](#layer-4-agents--subagents)
7. [Layer 5: Security](#layer-5-security)
8. [Layer 6: Session Persistence](#layer-6-session-persistence)
9. [Layer 7: Skills](#layer-7-skills)
10. [Layer 8: Configuration & Project Rules](#layer-8-configuration--project-rules)
11. [Layer 9: CLI & TUI](#layer-9-cli--tui)
12. [Testing Strategy](#testing-strategy)
13. [Observability & Debugging](#observability--debugging)
14. [CI/CD & Distribution](#cicd--distribution)
15. [Documentation & Portfolio](#documentation--portfolio)
16. [Implementation Order](#implementation-order)
17. [Directory Structure](#directory-structure)

---

## Design Principles

1. **One loop, many agents** — the agent loop is a single function. Agents are configurations, not code.
2. **Tools are the API** — everything the LLM does goes through a tool. No special-cased behavior.
3. **Security by default** — path validation, command gating, secret protection are built in, not bolted on.
4. **Streaming-first** — every LLM interaction is a stream. No batch-then-display.
5. **Mandatory output limits** — tool output is always truncated. The LLM must never receive unbounded content.
6. **Simple persistence** — append-only JSONL. No database, no complex formats.
7. **Direct SDK usage** — no Langchain, no AI SDK, no abstractions over abstractions.
8. **Cache-friendly** — system prompt is static per session, tool schemas sorted deterministically.
9. **Fail fast** — invalid config, context overflow, missing keys all surface immediately.
10. **Tested by default** — every pure function and integration boundary has tests. Tests are the proof you understand what you built.

---

## System Architecture

```
┌─────────────────────────────────────────┐
│          CLI / TUI Interface            │  Layer 9
├─────────────────────────────────────────┤
│     Configuration & Project Rules       │  Layer 8
├─────────────────────────────────────────┤
│              Skills                     │  Layer 7
├─────────────────────────────────────────┤
│        Session Persistence              │  Layer 6
├─────────────────────────────────────────┤
│              Security                   │  Layer 5
├─────────────────────────────────────────┤
│        Agents & Subagents               │  Layer 4
├─────────────────────────────────────────┤
│           Agent Loop                    │  Layer 3
├─────────────────────────────────────────┤
│           Tool System                   │  Layer 2
├─────────────────────────────────────────┤
│      LLM Provider Abstraction          │  Layer 1
└─────────────────────────────────────────┘
```

**Data flow for a single user message:**

```
User input
  → CLI parses (skill invocation? slash command? plain prompt?)
  → Load agent config ("build" by default)
  → Agent loop starts
    → Check context limit (hard stop if exceeded)
    → Build LLM context (system prompt + AGENTS.md + messages + tool schemas)
    → Stream LLM response (retry up to 3x on network/rate errors)
    → Extract tool calls from response
    → Validate + security check all tool calls, batch permission prompts
    → Execute tools sequentially
    → Append tool results to messages
    → Loop back to LLM if tool calls were made
  → Agent loop ends (no more tool calls)
  → Persist messages to session JSONL
  → Display final response to user
```

---

## Layer 1: LLM Provider Abstraction

### Design Decision: Anthropic-flavored Canonical Format

The internal message format uses content blocks (text, thinking, tool_call) inside
assistant messages. This is the Anthropic native format and the more expressive superset.

The OpenAI provider reshapes to/from its `tool_calls` array format. This same converter
works for xAI (Grok), GLM (Zhipu), Kimi (Moonshot), DeepSeek, and any OpenAI-compatible
API. A future Gemini adapter would be a third converter.

Effectively: two converters cover the entire market.

### Core Types

```typescript
// --- Provider ---

type ProviderId = "anthropic" | "openai";

interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
}

interface Provider {
  id: ProviderId;
  stream(model: string, context: LLMContext, signal?: AbortSignal): AsyncIterable<StreamEvent>;
}

// --- Context sent to LLM ---

interface LLMContext {
  systemPrompt: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
}

// --- Messages ---

type Message = UserMessage | AssistantMessage | ToolResultMessage;

interface UserMessage {
  role: "user";
  content: string;
}

interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  usage?: TokenUsage;
  stopReason?: "stop" | "tool_use" | "length" | "error";
}

interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

// --- Assistant content blocks ---

type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;

interface TextBlock {
  type: "text";
  text: string;
}

interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

// --- Streaming events (discriminated union) ---

type StreamEvent =
  | { type: "message_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "message_end"; usage: TokenUsage; stopReason: string }
  | { type: "error"; error: Error };

// --- Token tracking ---

interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
```

### Model Metadata (Hardcoded)

Single source of truth for pricing, context windows, and capabilities.
Updated when new models ship. ~30 lines for 2 providers.

```typescript
interface ModelMetadata {
  id: string;
  provider: ProviderId;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  supportsCaching: boolean;
}

interface ModelPricing {
  input: number; // Cost per 1M tokens
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const MODELS: Record<string, ModelMetadata> = {
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    supportsCaching: true,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    supportsCaching: true,
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    supportsCaching: true,
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2.5, output: 15, cacheRead: 1.25 },
    supportsCaching: true,
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.75, output: 4.5, cacheRead: 0.375 },
    supportsCaching: true,
  },
  "gpt-5.4-nano": {
    id: "gpt-5.4-nano",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.2, output: 1.25, cacheRead: 0.1 },
    supportsCaching: true,
  },
};

function getModelMetadata(model: string): ModelMetadata {
  const meta = MODELS[model];
  if (!meta) throw new Error(`Unknown model: ${model}. Add it to MODELS in models.ts`);
  return meta;
}
```

### Token Cost Calculation

```typescript
function calculateCost(model: string, usage: TokenUsage): number {
  const meta = getModelMetadata(model); // throws on unknown model (fail-fast)
  const { pricing } = meta;
  return (
    (usage.inputTokens * pricing.input) / 1_000_000 +
    (usage.outputTokens * pricing.output) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? 0)) / 1_000_000 +
    ((usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? 0)) / 1_000_000
  );
}
```

### Provider Implementation Pattern

Each provider is a single file that implements the `Provider` interface. It translates
the provider's SDK stream into the common `StreamEvent` type.

```typescript
// src/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk";

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({ apiKey: config.apiKey });

  return {
    id: "anthropic",
    async *stream(model, context, signal) {
      const stream = client.messages.stream(
        {
          model,
          system: context.systemPrompt,
          messages: convertMessages(context.messages), // Map to Anthropic format (nearly 1:1)
          tools: convertTools(context.tools),
          max_tokens: context.maxTokens,
        },
        { signal },
      );

      // Anthropic splits usage across two stream events:
      // - message_start carries input_tokens (+ cache tokens)
      // - message_delta carries output_tokens
      // We capture input usage here and merge into message_end so consumers
      // see complete TokenUsage in one place.
      let inputUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

      for await (const event of stream) {
        if (event.type === "message_start") {
          inputUsage = extractInputUsage(event); // input + cache tokens
        }
        yield mapToStreamEvent(event, inputUsage); // Normalize to common StreamEvent
      }
    },
  };
}
```

```typescript
// src/providers/openai.ts — also works for xAI, GLM, Kimi, DeepSeek via baseUrl
import OpenAI from "openai";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl });

  return {
    id: "openai",
    async *stream(model, context, signal) {
      const stream = await client.chat.completions.create(
        {
          model,
          messages: convertMessages(context.messages), // Reshape content blocks → tool_calls array
          tools: convertTools(context.tools),
          max_tokens: context.maxTokens,
          stream: true,
        },
        { signal },
      );

      for await (const chunk of stream) {
        yield mapToStreamEvent(chunk); // Normalize to common StreamEvent
      }
    },
  };
}
```

### Provider Registry

```typescript
// src/providers/registry.ts
const providers = new Map<ProviderId, Provider>();

function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider);
}

function getProvider(id: ProviderId): Provider {
  const provider = providers.get(id);
  if (!provider) throw new Error(`Unknown provider: ${id}`);
  return provider;
}
```

### Partial JSON Parsing

Tool arguments arrive incrementally during streaming. Accumulate the raw string
and attempt a full parse on `tool_call_end`. When the full parse fails (e.g. the
stream was interrupted), attempt recovery by closing open structures.

This is a non-trivial algorithmic problem — the parser must handle unclosed strings,
nested objects/arrays, and trailing commas without a full JSON grammar.

```typescript
function parsePartialJson<T>(incomplete: string): T {
  try {
    return JSON.parse(incomplete);
  } catch {
    return closeBrackets(incomplete) as T;
  }
}

function closeBrackets(input: string): unknown {
  // Strategy: scan character by character, track open structures.
  //
  // 1. Track a stack of open delimiters: { [ "
  // 2. Handle escape sequences inside strings (\" should not close a string)
  // 3. If inside a string when input ends, close the string with "
  // 4. Strip any trailing comma or colon (incomplete key-value pair)
  // 5. Close remaining open brackets/braces in reverse stack order
  // 6. Attempt JSON.parse on the repaired string
  // 7. If that still fails, return an empty object {}
  //
  // Edge cases to handle:
  //   '{"name": "hel'           → '{"name": "hel"}'
  //   '{"items": [1, 2'         → '{"items": [1, 2]}'
  //   '{"a": {"b": 1'           → '{"a": {"b": 1}}'
  //   '{"key":'                 → '{}' (strip incomplete pair)
  //   '{"a": "line1\nli'        → '{"a": "line1\nli"}'
  //   '{"a": true, "b":'        → '{"a": true}' (strip incomplete pair)

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastValidPos = 0;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === '"') inString = false;
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
      case "[":
        stack.push(ch);
        break;
      case "}":
        if (stack.at(-1) === "{") stack.pop();
        lastValidPos = i;
        break;
      case "]":
        if (stack.at(-1) === "[") stack.pop();
        lastValidPos = i;
        break;
    }
  }

  let repaired = input;

  // Close open string
  if (inString) repaired += '"';

  // Strip trailing incomplete key-value (comma, colon, or dangling key)
  repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*$/, "");
  repaired = repaired.replace(/,\s*$/, "");
  repaired = repaired.replace(/:\s*$/, "");

  // Close remaining open structures
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }

  try {
    return JSON.parse(repaired);
  } catch {
    return {};
  }
}
```

### Retry with Exponential Backoff

Network errors and rate limits are retried before surfacing to the agent loop.

```typescript
const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  retryableStatuses: [429, 500, 502, 503, 529],
};

async function* streamWithRetry(
  provider: Provider,
  model: string,
  context: LLMContext,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      yield* provider.stream(model, context, signal);
      return; // Success
    } catch (error) {
      lastError = error as Error;
      if (!isRetryable(error) || attempt === RETRY_CONFIG.maxRetries) break;
      const delay = RETRY_CONFIG.baseDelayMs * 2 ** attempt; // 1s, 2s, 4s
      await Bun.sleep(delay);
    }
  }

  // Discard partial stream on failure — the LLM can regenerate
  throw lastError;
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    // Rate limit or server errors
    const status = (error as { status?: number }).status;
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true;
    // Network errors
    if (error.message.includes("ECONNRESET") || error.message.includes("fetch failed")) return true;
  }
  return false;
}
```

### Context Limit Check

No compaction. Hard stop when context is full. Uses **real token counts** from
provider responses, not estimation.

```typescript
const CONTEXT_RESERVE = 20_000; // Space for system prompt + tools + response

interface ContextTracker {
  lastKnownInputTokens: number; // From most recent provider response
  contextWindow: number; // From model metadata
}

function isContextExhausted(tracker: ContextTracker): boolean {
  return tracker.lastKnownInputTokens > tracker.contextWindow - CONTEXT_RESERVE;
}

// Called after each LLM response:
function updateTokenTracking(tracker: ContextTracker, usage: TokenUsage): void {
  tracker.lastKnownInputTokens = usage.inputTokens;
}

// Fallback estimation for the very first message (no prior usage data):
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

When exhausted, the agent loop stops and surfaces to the user:

```
Session context full (182k / 200k tokens).
Start a new session or use /clear to reset.
```

---

## Layer 2: Tool System

### Tool Definition Interface

```typescript
interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  description: string; // Shown to LLM
  parameters: JsonSchema; // JSON Schema for validation
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult>;
}

interface ConfirmRequest {
  tool: string;
  description: string; // Human-readable preview of what will happen
  reason: string; // Why confirmation is needed
}

interface ToolContext {
  cwd: string; // Working directory
  signal: AbortSignal; // Cancellation
  // Confirmation hook for destructive operations (bash, etc.). In Sprint 2
  // this defaults to always-allow when undefined; Sprint 3 wires it to a
  // real user prompt via src/security/permissions.ts.
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

// Deliberately restricted to the shapes we actually use. Keeps the validator
// small and schemas easy to read. Extend only when a new tool needs it.
type JsonSchemaPrimitive = "string" | "number" | "integer" | "boolean";

type JsonSchemaProperty =
  | {
      type: JsonSchemaPrimitive;
      description?: string;
      enum?: readonly string[];
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "array";
      description?: string;
      items: { type: JsonSchemaPrimitive };
    };

interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}
```

### Tool Registry

Tools are registered at startup. Schemas are sorted deterministically for prompt caching.

```typescript
const tools = new Map<string, ToolDefinition>();

function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool);
}

function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

function getToolSchemas(allowedTools: string[]): ToolSchema[] {
  return allowedTools
    .sort() // Deterministic order for prompt caching
    .map((name) => tools.get(name))
    .filter(Boolean)
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }));
}
```

### Output Truncation (Mandatory)

Every tool result passes through truncation before reaching the LLM:

```typescript
const MAX_LINES = 2000;
const MAX_BYTES = 50_000; // 50KB

interface TruncationResult {
  content: string;
  wasTruncated: boolean;
  originalLines: number;
  originalBytes: number;
}

function truncateHead(output: string): TruncationResult {
  // Keep the beginning (for file reads, search results)
  // Never cut mid-line
}

function truncateTail(output: string): TruncationResult {
  // Keep the end (for bash output — errors are at the bottom)
  // Never cut mid-line
}
```

When truncated, append metadata so the LLM knows:

```
[Output truncated: showed first 2000 of 15432 lines (50KB of 230KB).
Use offset/limit parameters or grep to find specific content.]
```

### Argument Validation

Because `JsonSchema` is restricted to primitives + single-type arrays (with
optional `enum`/`minimum`/`maximum`), we hand-roll the validator rather than
pulling in AJV. ~90 lines of code, zero dependencies, structured errors:

```typescript
function validateArgs(schema: JsonSchema, args: unknown): { valid: boolean; errors: string[] } {
  // 1. args must be a plain object
  // 2. Every key in `required` must be present
  // 3. Each property that IS declared must match its type (primitive / array-of-primitive)
  // 4. enum / minimum / maximum constraints are enforced
  // 5. Unknown properties are ignored (LLMs sometimes pad with extras)
}
```

On validation failure, return an error ToolResult — the loop continues, the LLM gets
feedback and can retry.

### 7 Built-in Tools

#### `read` — Read file contents

```typescript
{
  name: "read",
  parameters: {
    path: string,         // Required. Absolute or relative to cwd
    offset?: number,      // Start line (1-based)
    limit?: number,       // Max lines to read
  },
  // Returns: file content with line numbers (cat -n style)
  // Truncation: truncateHead
  // Security: path validation (Layer 5)
  // Special: detect binary files → return "(binary file, N bytes)"
}
```

#### `write` — Create or overwrite files

```typescript
{
  name: "write",
  parameters: {
    path: string,         // Required
    content: string,      // Required. Full file content
  },
  // Creates parent directories if needed (mkdir -p)
  // Security: path validation, secrets detection
}
```

#### `edit` — Search-and-replace in files

```typescript
{
  name: "edit",
  parameters: {
    path: string,         // Required
    old_string: string,   // Required. Exact text to find
    new_string: string,   // Required. Replacement text
    replace_all?: boolean // Default: false. When true, replace ALL matches.
  },
  // When replace_all=false: fails if old_string not found OR matches multiple locations
  // When replace_all=true: replaces every occurrence (useful for renames)
  // Returns: confirmation with surrounding context showing the change
  // Security: path validation, secrets detection on new_string
}
```

#### `bash` — Execute shell commands

```typescript
{
  name: "bash",
  parameters: {
    command: string,       // Required. Shell command to run
    timeout_ms?: number,   // Max execution time in ms (default: 120_000, max: 600_000)
  },
  // Execution: Bun.spawn("/bin/sh", "-c", cmd) with cwd + env inherited
  // Output: combined stdout+stderr, shown to user AFTER completion (spinner while running)
  // Truncation: truncateTail (errors at bottom)
  // Cancellation: compose context.signal (Ctrl+C) with internal timeout signal via AbortSignal.any
  // Security: dangerous command detection (Layer 5). Confirmation commands defer
  //   to ToolContext.confirm; absent confirm defaults to allow (Sprint 2 permissive).
}
```

#### `grep` — Search file contents

```typescript
{
  name: "grep",
  parameters: {
    pattern: string,       // Required. Regex pattern (ripgrep/rust regex flavor)
    path?: string,         // Directory to search (default: cwd)
    include?: string,      // Glob filter (e.g., "*.ts")
    ignore_case?: boolean, // Case-insensitive match. Default: false
    files_only?: boolean,  // Return paths only, no line content. Default: false
  },
  // Implementation: requires ripgrep (rg). Returns a clear install hint if missing.
  //   No manual fallback — the "degraded" code path would be slower and worse.
  // Output: `path:line:match` per hit (or just `path` with files_only)
  // Exit codes: 0 = matches, 1 = no matches (not an error), 2 = error
  // Truncation: truncateHead
}
```

#### `glob` — Find files by pattern

```typescript
{
  name: "glob",
  parameters: {
    pattern: string,      // Required. Glob pattern (e.g., "src/**/*.ts")
    path?: string,        // Base directory (default: cwd)
    dot?: boolean,        // Include dotfiles/dotdirs (.github, .claude). Default: false
  },
  // Implementation: Bun.Glob.scan
  // Returns: sorted relative paths. Belt-and-suspenders relative check drops any
  //   match that escapes the search root (defense against symlink tricks).
  // Truncation: truncateHead
}
```

#### `spawn_agent` — Invoke a subagent (see Layer 4)

```typescript
{
  name: "spawn_agent",
  parameters: {
    agent: "plan" | "explore",  // Required. Subagent to invoke
    prompt: string,              // Required. Task description
  },
  // Execution: runs a nested agent loop with the subagent's config
  // Returns: the subagent's final text response (opaque — subagent messages NOT stored)
  // Subagent gets: parent's AGENTS.md + system context, fresh message history
  // Cost: displayed to user after completion ("Explore agent: 3 turns, 8.2k tokens, $0.02")
}
```

---

## Layer 3: Agent Loop

The core algorithm. A single function that handles any agent configuration.

### Interface

```typescript
interface AgentLoopConfig {
  agent: AgentConfig; // Which agent (build, plan, explore)
  provider: Provider; // LLM provider
  model: string; // Model ID
  // Conversation history. NOT mutated — the loop clones it on entry and
  // returns the clone on the result so callers keep their own reference.
  messages: readonly Message[];
  systemPrompt: string; // Assembled once at session start (static for caching)
  cwd: string; // Working directory passed to every tool execution
  // Required. Callers that don't need cancellation should pass
  // `new AbortController().signal` (never fires). Keeping it mandatory
  // means tool execution always has a concrete signal to forward.
  signal: AbortSignal;
  onEvent?: (event: AgentEvent) => void; // Progress callback for UI
  // Injected for tests / future UIs; defaults to a readline-based prompter.
  prompter?: PermissionPrompter;
  // Session-scoped "allow for session" memory. The CLI creates one per user
  // session and reuses it across agentLoop calls; subagents inherit the
  // parent's store. Defaults to a fresh store per call.
  permissionStore?: PermissionStore;
  maxTurns?: number; // Optional override for agent.maxTurns
}

// Tools are NOT passed here — the loop reads them from the module-level
// registry using `agent.tools` names, and enforces the allow-list in
// validateToolCalls as defense-in-depth.

interface AgentLoopResult {
  messages: Message[]; // Updated message history (clone of input + appended turns)
  usage: TokenUsage; // Accumulated token usage
  turns: number; // How many LLM calls were made
  stopReason: AgentStopReason; // Why the loop exited — see below
}

// Explicit termination taxonomy. Default is "turn_limit" so falling out of
// the while-condition without an explicit set is reported truthfully rather
// than silently.
type AgentStopReason = "done" | "aborted" | "context_limit" | "turn_limit" | "error";
```

### Agent Events (for UI)

```typescript
type AgentEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; name: string; id: string }
  | { type: "tool_call_args"; name: string; partialArgs: string }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "turn_end"; usage: TokenUsage }
  | { type: "context_limit_reached" }
  | { type: "turn_limit_reached"; maxTurns: number }
  | {
      type: "subagent_complete";
      agent: string;
      turns: number;
      tokens: number;
      cost: number;
    }
  | { type: "error"; error: Error };
```

### The Loop

```typescript
async function agentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { agent, provider, model, systemPrompt, cwd, signal, onEvent } = config;
  const prompter = config.prompter ?? createReadlinePrompter();
  const permissionStore = config.permissionStore ?? createPermissionStore();
  const maxTurns = config.maxTurns ?? agent.maxTurns;
  // Clone on entry — input stays untouched; caller keeps its own reference.
  const messages: Message[] = [...config.messages];

  const modelMeta = getModelMetadata(model);
  const tracker = createContextTracker(model);

  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;
  // Default to "turn_limit" so exiting via the while-condition is reported
  // truthfully. Every other exit path sets this explicitly.
  let stopReason: AgentStopReason = "turn_limit";

  while (turn < maxTurns) {
    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }

    if (isContextExhausted(tracker)) {
      onEvent?.({ type: "context_limit_reached" });
      stopReason = "context_limit";
      break;
    }

    turn++;
    onEvent?.({ type: "turn_start", turn });

    let assistantMessage: AssistantMessage;
    try {
      const stream = streamWithRetry(
        provider,
        model,
        {
          systemPrompt,
          messages,
          tools: getToolSchemas(agent.tools), // read from module-level registry
          maxTokens: modelMeta.maxOutputTokens,
        },
        signal,
      );
      assistantMessage = await accumulateStream(stream, onEvent);
    } catch (error) {
      // An abort mid-stream surfaces as the SDK's abort error; normalize to
      // our "aborted" stop reason rather than "error".
      if (signal.aborted) {
        stopReason = "aborted";
      } else {
        const err = error instanceof Error ? error : new Error(String(error));
        onEvent?.({ type: "error", error: err });
        stopReason = "error";
      }
      break;
    }

    messages.push(assistantMessage);
    const usage = assistantMessage.usage ?? { inputTokens: 0, outputTokens: 0 };
    totalUsage = addUsage(totalUsage, usage);
    updateTokenTracking(tracker, usage);
    onEvent?.({ type: "turn_end", usage });

    const toolCalls = extractToolCalls(assistantMessage);
    if (toolCalls.length === 0) {
      stopReason = "done";
      break;
    }

    if (signal.aborted) {
      stopReason = "aborted";
      break;
    }

    // Three-phase tool handling, each independently testable:
    //   1. validate        — JSON schema + bash command-detection
    //   2. resolve perms   — consult store, prompt the user for the rest
    //   3. execute         — run approved tools, truncate, wrap as messages
    const validated = validateToolCalls(toolCalls, agent.tools);
    await resolveValidatedPermissions(validated, prompter, permissionStore);
    const toolResults = await executeToolsSequential(validated, cwd, signal, onEvent);
    messages.push(...toolResults);
  }

  if (stopReason === "turn_limit") {
    onEvent?.({ type: "turn_limit_reached", maxTurns });
  }

  return { messages, usage: totalUsage, turns: turn, stopReason };
}
```

### `accumulateStream` — Stream Events to AssistantMessage

Two invariants this function protects:

1. **Text/thinking deltas extend the _most recent_ block of that kind.** If
   the stream interleaves `text → tool_call → text`, that's two separate
   `TextBlock`s — the `tool_call` in between breaks the run.
2. **Tool-call arguments buffer per-id, not globally.** Multiple tool calls
   in a single turn each keep their own raw JSON buffer, so they can't
   cross-contaminate. Parsing happens on `tool_call_end` via
   `parsePartialJson` (recovery-oriented — see Layer 1).

The function throws on `error` events _or_ when the stream ends without a
`message_end` (partial response). The loop's try/catch translates these into
either `aborted` or `error` stop reasons.

```typescript
async function accumulateStream(
  events: AsyncIterable<StreamEvent>,
  onEvent?: AgentEventHandler,
): Promise<AssistantMessage> {
  const content: AssistantContent[] = [];
  // Raw partial-JSON buffer per tool_call id.
  const toolCallBuffers = new Map<string, string>();
  let activeToolCallId: string | null = null;

  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "stop";
  let sawMessageEnd = false;

  for await (const event of events) {
    switch (event.type) {
      case "text_delta":
        appendToLastTextBlock(content, event.text);
        onEvent?.({ type: "text_delta", text: event.text });
        break;

      case "thinking_delta":
        appendToLastThinkingBlock(content, event.thinking);
        onEvent?.({ type: "thinking_delta", thinking: event.thinking });
        break;

      case "tool_call_start":
        content.push({ type: "tool_call", id: event.id, name: event.name, arguments: {} });
        toolCallBuffers.set(event.id, "");
        activeToolCallId = event.id;
        onEvent?.({ type: "tool_call_start", name: event.name, id: event.id });
        break;

      case "tool_call_delta": {
        if (activeToolCallId === null) break; // malformed stream — drop
        const buffered = (toolCallBuffers.get(activeToolCallId) ?? "") + event.arguments;
        toolCallBuffers.set(activeToolCallId, buffered);
        onEvent?.({ type: "tool_call_args", name: "", partialArgs: buffered });
        break;
      }

      case "tool_call_end": {
        if (activeToolCallId === null) break;
        const raw = toolCallBuffers.get(activeToolCallId) ?? "";
        const block = content.find(
          (b): b is ToolCallBlock => b.type === "tool_call" && b.id === activeToolCallId,
        );
        if (block) {
          block.arguments = raw.trim().length === 0 ? {} : parsePartialJson(raw);
        }
        activeToolCallId = null;
        break;
      }

      case "message_end":
        usage = event.usage;
        // Coerce to our canonical 4-value set as a last-resort guard against
        // a buggy provider smuggling an off-spec string into persisted history.
        stopReason = coerceStopReason(event.stopReason);
        sawMessageEnd = true;
        break;

      case "error":
        throw event.error;
    }
  }

  if (!sawMessageEnd) throw new Error("Stream ended before message_end event");

  return { role: "assistant", content, usage, stopReason };
}
```

### Sequential Tool Execution

Three functions, three phases. Keeping them separate means each can be
unit-tested without spinning up the whole loop.

```typescript
interface ValidatedToolCall {
  call: ToolCallBlock;
  tool: ToolDefinition | null;
  // Set if this call cannot be executed (unknown tool, bad args, blocked, denied).
  error?: string;
  // Set if this call needs user confirmation before executing.
  pendingPermission?: PermissionRequest;
}
```

#### Phase 1: `validateToolCalls` — schema + security pre-check

Pure function (no prompter, no async). Runs JSON-schema validation and, for
bash, runs `checkCommand` to distinguish **blocked** (error) from
**needs-confirm** (pending). When `allowedTools` is passed, tool calls outside
the agent's allow-list are rejected as errors — defense-in-depth against a
malformed stream or a recycled message history smuggling in an unauthorized
tool name.

```typescript
function validateToolCalls(
  toolCalls: readonly ToolCallBlock[],
  allowedTools?: readonly string[],
): ValidatedToolCall[] {
  const results: ValidatedToolCall[] = [];
  const allowed = allowedTools ? new Set(allowedTools) : null;

  for (const call of toolCalls) {
    if (allowed && !allowed.has(call.name)) {
      results.push({
        call,
        tool: null,
        error: `Tool "${call.name}" is not available to this agent`,
      });
      continue;
    }
    const tool = getTool(call.name);
    if (!tool) {
      results.push({ call, tool: null, error: `Unknown tool: ${call.name}` });
      continue;
    }
    const validation = validateArgs(tool.parameters, call.arguments);
    if (!validation.valid) {
      results.push({
        call,
        tool,
        error: `Invalid arguments for ${call.name}: ${validation.errors.join("; ")}`,
      });
      continue;
    }
    // Bash is the one tool that can be blocked outright or need confirmation.
    // Pre-checking here (rather than only inside bash.ts) lets us batch-prompt
    // before any execution starts.
    if (call.name === "bash") {
      const command = (call.arguments as { command?: unknown }).command;
      if (typeof command === "string") {
        const check = checkCommand(command);
        if (!check.allowed) {
          results.push({ call, tool, error: `bash blocked: ${check.reason}` });
          continue;
        }
        if (check.requiresConfirmation) {
          results.push({
            call,
            tool,
            pendingPermission: { tool: "bash", description: command, reason: check.reason },
          });
          continue;
        }
      }
    }
    results.push({ call, tool });
  }
  return results;
}
```

#### Phase 2: `resolveValidatedPermissions` — prompt and adjudicate

Async. Consults the `PermissionStore` first, asks the prompter only for
unresolved requests, and mutates `validated` in place — approved calls lose
their `pendingPermission`; denied calls gain an `error`. See Layer 5 for the
prompter / store design.

```typescript
async function resolveValidatedPermissions(
  validated: ValidatedToolCall[],
  prompter: PermissionPrompter,
  store: PermissionStore,
): Promise<void> {
  const pending = validated.filter((v) => v.pendingPermission !== undefined);
  if (pending.length === 0) return;

  const decisions = await resolvePermissions(
    pending.map((v) => v.pendingPermission!),
    prompter,
    store,
  );

  for (const [i, decision] of decisions.entries()) {
    const target = pending[i]!;
    if (decision === "deny") {
      target.error = `User denied permission: ${target.pendingPermission!.reason}`;
    }
    delete target.pendingPermission;
  }
}
```

#### Phase 3: `executeToolsSequential` — run and truncate

Tools run one at a time. Errors (unknown tool, bad args, blocked, denied,
aborted) skip execution and emit an error `ToolResultMessage`. The _one_
invariant enforced here: the LLM never sees unbounded content — everything is
truncated first.

Tools don't re-prompt; the loop pre-resolved permissions, so `context.confirm`
is auto-approved (`() => true`). Denials already became `v.error` upstream.

```typescript
async function executeToolsSequential(
  validated: readonly ValidatedToolCall[],
  cwd: string,
  signal: AbortSignal,
  onEvent?: AgentEventHandler,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = [];

  for (const v of validated) {
    // Honor aborts between tools so a long batch cancels promptly instead of
    // running every remaining call to completion.
    if (signal.aborted) {
      results.push(errorResult(v, "aborted before execution"));
      continue;
    }
    if (v.error || !v.tool) {
      results.push(errorResult(v, v.error ?? `Unknown tool: ${v.call.name}`));
      onEvent?.({
        type: "tool_result",
        name: v.call.name,
        result: { content: v.error!, isError: true },
      });
      continue;
    }

    let result: ToolResult;
    try {
      result = await v.tool.execute(v.call.arguments, {
        cwd,
        signal,
        confirm: () => Promise.resolve(true), // pre-resolved
      });
    } catch (error) {
      // One tool throwing does NOT abort the batch: the LLM sees the error
      // next turn and decides whether remaining tools are still useful.
      const message = error instanceof Error ? error.message : String(error);
      result = { content: `${v.call.name} threw: ${message}`, isError: true };
    }

    const truncated =
      v.call.name === "bash" ? truncateTail(result.content) : truncateHead(result.content);

    results.push({
      role: "tool_result",
      toolCallId: v.call.id,
      toolName: v.call.name,
      content: truncated.content,
      ...(result.isError !== undefined && { isError: result.isError }),
    });
    onEvent?.({ type: "tool_result", name: v.call.name, result });
  }
  return results;
}
```

---

## Layer 4: Agents & Subagents

### Agent Configuration

```typescript
interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[]; // Tool names this agent can use
  maxTurns: number;
}
```

### Built-in Agents

```typescript
const AGENTS: Record<string, AgentConfig> = {
  build: {
    name: "build",
    description: "Main coding agent with full tool access for reading, writing, and executing code",
    systemPrompt: `You are Tokenius, a coding assistant. You help users with software engineering tasks.
You have access to tools for reading, writing, editing files, running commands, and searching code.
When a task requires exploration or planning without changes, delegate to a subagent.`,
    tools: ["bash", "read", "write", "edit", "grep", "glob", "spawn_agent"],
    maxTurns: 50,
  },

  plan: {
    name: "plan",
    description:
      "Planning and analysis agent. Reads code, reasons about architecture, produces plans. Cannot modify files or run commands.",
    systemPrompt: `You are a planning assistant. Analyze code, reason about architecture, and produce detailed plans.
You CANNOT modify files or run commands — only read and search.
Be thorough but concise. Structure your output with clear headings.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 20,
  },

  explore: {
    name: "explore",
    description:
      "Fast codebase exploration agent. Searches files, reads code, answers questions about the codebase. Cannot modify anything.",
    systemPrompt: `You are a codebase exploration assistant. Quickly find files, search patterns, and read code to answer questions.
Be concise — report findings, not process.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 10,
  },
};
```

**Note:** Subagents (plan, explore) do NOT get the `spawn_agent` tool — no recursive spawning.

### `spawn_agent` Tool Implementation — Factory Pattern

`spawn_agent` is the one tool that IS the agent — it runs a nested agent loop.
That breaks the usual "tools don't know about agents" separation, so it's
built as a **factory** that closes over the parent's provider, model, cwd,
event handler, permission flow, and AGENTS.md. The CLI (Sprint 6) calls this
once at startup and registers the resulting `ToolDefinition` before the main
loop begins.

Avoiding module-level `currentProvider` / `currentModel` / `onEvent` globals
makes the tool testable with a mock provider and safe for future concurrent
use (subagents side-by-side).

**Isolation guarantees:**

- Subagent starts with a fresh message history (just the user prompt).
- Subagent gets its own `systemPrompt` built from its own `AgentConfig` —
  build's prompt does not leak down.
- Subagent tools are restricted via `AgentConfig.tools`; `validateToolCalls`
  enforces the allow-list.
- `spawn_agent` is deliberately omitted from plan/explore's tool list — no
  recursive spawning.
- The subagent's own `AgentEvent` stream is NOT forwarded to the parent —
  they'd interleave confusingly. The parent only sees a single
  `subagent_complete` summary.
- Parent sees only the final assistant text; intermediate messages stay
  inside the subagent call.

```typescript
interface CreateSpawnAgentToolOptions {
  provider: Provider;
  model: string;
  cwd: string;
  onEvent?: AgentEventHandler;
  agentsMd?: string | null;
  prompter?: PermissionPrompter;
  // Passing the parent's store through avoids re-prompting the user for a
  // category they already approved for this session.
  permissionStore?: PermissionStore;
}

function createSpawnAgentTool(options: CreateSpawnAgentToolOptions): ToolDefinition {
  const subagentNames = Object.keys(AGENTS).filter((name) => name !== "build");

  return {
    name: "spawn_agent",
    description: `Spawn a subagent for a focused subtask. Available agents:
- "plan": Planning and analysis. Reads code but cannot modify. Use for architecture, design, code review.
- "explore": Fast codebase exploration. Use to find files, search patterns, or understand structure.
The subagent returns its final text response; its intermediate messages are not visible.`,
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", enum: subagentNames },
        prompt: { type: "string", description: "Task description for the subagent." },
      },
      required: ["agent", "prompt"],
    },
    async execute(params, context) {
      const agentConfig = getAgent(params.agent);
      if (!agentConfig) return { content: `Unknown subagent: ${params.agent}`, isError: true };
      if (agentConfig.name === "build") {
        return { content: `Cannot spawn build agent via spawn_agent`, isError: true };
      }

      const result = await agentLoop({
        agent: agentConfig,
        provider: options.provider,
        model: options.model,
        messages: [{ role: "user", content: params.prompt }],
        systemPrompt: buildSystemPrompt({ agent: agentConfig, agentsMd: options.agentsMd }),
        cwd: options.cwd,
        signal: context.signal,
        // Intentionally NOT forwarding options.onEvent — see isolation note.
        ...(options.prompter && { prompter: options.prompter }),
        ...(options.permissionStore && { permissionStore: options.permissionStore }),
      });

      const text = extractFinalText(result.messages);

      // Parent UI gets one summary event. Cost stays in the event, NOT in
      // the tool result — the LLM doesn't need to see dollar amounts.
      options.onEvent?.({
        type: "subagent_complete",
        agent: agentConfig.name,
        turns: result.turns,
        tokens: result.usage.inputTokens + result.usage.outputTokens,
        cost: calculateCost(options.model, result.usage),
      });

      // stopReason flows into the ToolResult: only "done" is a clean success.
      // Everything else surfaces as isError with context so the parent LLM
      // can react (retry, give up, ask for clarification) rather than
      // treating partial output as finished.
      return buildResult(result.stopReason, text);
    },
  };
}
```

### System Prompt Assembly

Built **once per session** and reused for every LLM call (prompt caching).
No dynamic content (no timestamps, no turn counts). Anything the prompt
mentions must be stable for the life of the session.

The builder does **not** load AGENTS.md or discover skills itself — the
caller passes them in. Two reasons: (1) keeps the builder pure and testable
without touching the filesystem, and (2) the CLI caches these loads once per
session, not per subagent.

The skills section lists `name + description` only. Full skill bodies are
injected into the **user message** at invocation time via `applySkill` —
that keeps the cached system prompt small regardless of how many skills are
available.

```typescript
interface SystemPromptOptions {
  agent: AgentConfig;
  agentsMd?: string | null; // Loaded by the caller via loadAgentsMd(cwd)
  skills?: readonly Skill[]; // Discovered once per session via discoverSkills(cwd)
}

function buildSystemPrompt(options: SystemPromptOptions): string {
  const parts: string[] = [options.agent.systemPrompt.trim()];

  if (options.agentsMd && options.agentsMd.trim().length > 0) {
    parts.push(`## Project Rules (AGENTS.md)\n\n${options.agentsMd.trim()}`);
  }

  if (options.skills && options.skills.length > 0) {
    parts.push(renderSkills(options.skills));
  }

  parts.push(`## Security Rules
- Never read or write files outside the project directory.
- Never write secrets or API keys to files — reference them via environment variables.
- Destructive commands (rm -rf, git reset --hard, force push, etc.) will prompt for user confirmation.`);

  return parts.join("\n\n");
}
```

---

## Layer 5: Security

### Path Validation

All file operations pass through path validation. Two subtleties make this
harder than it looks:

1. **Symlink canonicalization.** `cwd.startsWith(target)` is a naive string
   compare. On macOS `/tmp` is a symlink to `/private/tmp`; resolving with
   `realpath` makes both sides comparable.
2. **Non-existent targets.** The `write` tool creates new files. `realpath`
   throws on paths that don't exist, so we canonicalize the deepest existing
   ancestor and reattach the tail.

```typescript
interface PathValidationResult {
  valid: boolean;
  resolved: string; // Absolute path (realpath'd when the file exists)
  reason?: string;
}

const BLOCKED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "secrets.json",
]);

// Sensitive subpaths — matched as path segments, not substrings, so a repo
// literally named "objects" wouldn't be flagged unless it's under .git/.
const BLOCKED_SEGMENTS: readonly string[][] = [
  [".git", "objects"],
  [".git", "refs"],
  ["node_modules", ".cache"],
];

function validatePath(filePath: string, cwd: string): PathValidationResult {
  const target = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const resolvedTarget = canonicalize(target); // realpath or best-effort
  const resolvedCwd = canonicalize(cwd);

  // Containment check via relative path — "..", or an absolute relative, means escape.
  const rel = relative(resolvedCwd, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      valid: false,
      resolved: resolvedTarget,
      reason: "path is outside the project directory",
    };
  }

  if (BLOCKED_FILES.has(basename(resolvedTarget))) {
    /* ... */
  }
  // Segment-by-segment check against BLOCKED_SEGMENTS — prevents ".gitobjects"-style bypasses.
}
```

### Dangerous Command Detection

For the `bash` tool:

```typescript
interface CommandCheck {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\/(?!\w)/, reason: "rm targeting the filesystem root" },
  { pattern: /\bmkfs\b/, reason: "filesystem format" },
  { pattern: /\bdd\s+[^|&;]*of=\/dev\//, reason: "dd writing to a device" },
  { pattern: />\s*\/dev\/[sh]d/, reason: "redirect to block device" },
  { pattern: /\bcurl\b[^|&;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: "curl piped to shell" },
  { pattern: /\bwget\b[^|&;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: "wget piped to shell" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb" },
];

const CONFIRM_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)/, reason: "recursive/forced file deletion" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "hard git reset (destructive)" },
  { pattern: /\bgit\s+push\s+[^&|;]*--force\b/, reason: "force push (destructive)" },
  { pattern: /\bgit\s+push\s+[^&|;]*-f\b/, reason: "force push (destructive)" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, reason: "git clean removes untracked files" },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: "force-delete git branch" },
  { pattern: /\bdrop\s+table\b/i, reason: "SQL DROP TABLE" },
  { pattern: /\bdrop\s+database\b/i, reason: "SQL DROP DATABASE" },
  { pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, reason: "world-writable permissions" },
  { pattern: /\bsudo\b/, reason: "elevated privileges" },
];

function checkCommand(command: string): CommandCheck {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, requiresConfirmation: false, reason: "Command blocked for safety" };
    }
  }

  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: true, requiresConfirmation: true, reason };
    }
  }

  return { allowed: true, requiresConfirmation: false };
}
```

### Secrets Detection

Prevent the LLM from writing secrets to files. Two layers: high-signal
literal patterns for known key formats, plus a generic key/value heuristic
guarded against placeholder values so `YOUR_API_KEY_HERE` doesn't false-positive.

```typescript
const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /\bsk-proj-[a-zA-Z0-9_-]{20,}/, label: "OpenAI project key" },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /\bghp_[a-zA-Z0-9]{36,}/, label: "GitHub personal token" },
  { pattern: /\bgho_[a-zA-Z0-9]{36,}/, label: "GitHub OAuth token" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/, label: "AWS access key" },
];

// Generic: a variable named like a secret, assignment, long opaque value.
const GENERIC_KV =
  /(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token)\s*[:=]\s*["']?([a-zA-Z0-9_+\-/]{24,})["']?/i;
const PLACEHOLDER_VALUES = /^(your[_-]?|xxx|placeholder|example|todo|change[_-]?me)/i;

interface SecretsCheck {
  found: boolean;
  labels: string[]; // Each match is labeled so the tool error can explain what to fix.
}

function containsSecrets(content: string): SecretsCheck {
  /* ... */
}
```

Used in the `write` and `edit` tools — if detected, return an error ToolResult
with the labels so the LLM knows what to fix (e.g. "reference it via an
environment variable instead").

**Tradeoff:** false positives here mean the LLM retries with a different
approach; false negatives mean a leaked credential. Lean toward over-flagging.

### Permission Prompt Flow

Two moving parts kept separate so each can be tested and swapped independently:

- **`PermissionPrompter`** — _how_ the user is asked. The default is a
  readline prompt; Sprint 6 replaces it with proper TUI. Tests inject a fake.
- **`PermissionStore`** — a per-session `Set<reason>` of categories the user
  chose "allow for this session". Created by the caller (CLI → agent loop →
  subagents inherit) so two concurrent loops don't cross-contaminate approvals.

`resolvePermissions` is the one place both meet: it consults the store first,
asks the prompter only for unresolved requests, and updates the store based
on the prompter's answers.

```typescript
interface PermissionRequest {
  tool: string;
  description: string; // Preview (for bash: the command itself)
  reason: string; // CONFIRM reason from command-detection — also the store key
}

type PermissionResponse = "allow" | "deny" | "allow_session"; // Raw user choice
type PermissionDecision = "allow" | "deny"; // Post-adjudication outcome

type PermissionPrompter = (requests: PermissionRequest[]) => Promise<PermissionResponse[]>;

interface PermissionStore {
  has(reason: string): boolean;
  remember(reason: string): void;
  clear(): void;
  snapshot(): ReadonlySet<string>;
}

function createPermissionStore(): PermissionStore {
  /* Set-backed */
}
```

**Reasons excluded from session-scoped approval.** Some categories never get
"allow for session" — `allow_session` on an excluded reason is downgraded to
a one-time allow. Criteria for inclusion: irreversible (no `reflog` path
back) or affects state outside the local repo. Destructive-but-contained ops
(recursive `rm ./dist`, `git clean`) stay session-allowable so tight dev
loops aren't repeatedly interrupted.

```typescript
const SESSION_EXCLUDED_REASONS: ReadonlySet<string> = new Set([
  "elevated privileges", // sudo — always re-prompt
  "force push (destructive)", // remote state
  "hard git reset (destructive)", // no reflog for unpushed work
  "force-delete git branch", // branch gone
  "SQL DROP TABLE", // irreversible
  "SQL DROP DATABASE", // irreversible
]);

async function resolvePermissions(
  requests: readonly PermissionRequest[],
  prompter: PermissionPrompter,
  store: PermissionStore,
): Promise<PermissionDecision[]> {
  // 1. Pre-resolve from store: any reason already allowed for session → "allow".
  // 2. Prompt for the rest. "allow_session" updates the store unless excluded.
  // 3. Length mismatch from the prompter throws — that's a programming error,
  //    not a user denial.
}
```

If the user denies one tool call, the safe ones in the same batch still
execute. The denied call gets an error result (`"User denied permission: ..."`)
and the LLM adapts on the next turn.

---

## Layer 6: Session Persistence

### Design Decision: No Compaction

When the context window is full, the session hard-stops. The user can start a new
session or `/clear`. This removes significant complexity (cut-point detection,
LLM summarization, cheap-model routing) with an honest tradeoff.

### JSONL Format

One session = one `.jsonl` file. Stored project-local.

```
{project}/.tokenius/sessions/
  {session-id}.jsonl
```

**First-run hint:** `createSession` returns `isFirstInProject: true` the first time `.tokenius/sessions/` is created in a project. The CLI (Sprint 6) prints a one-time hint on that signal:

```
Session saved to .tokenius/sessions/abc123.jsonl
Tip: Add .tokenius/sessions/ to your .gitignore
```

The manager itself never writes to stdout; keeping I/O in the CLI layer lets tests create sessions silently.

### Session Header (First Line)

```json
{
  "type": "session",
  "id": "abc123",
  "timestamp": "2026-04-13T10:00:00Z",
  "cwd": "/Users/nikolas.b/Dev/myproject",
  "model": "claude-sonnet-4-6",
  "title": "Fix auth bug"
}
```

### Entry Types

```typescript
type SessionEntry = SessionHeader | MessageEntry;

interface SessionHeader {
  type: "session";
  id: string;
  timestamp: string; // ISO-8601, session creation time
  cwd: string; // Metadata; not used as a filter
  model: string; // Model id at session creation
  title?: string;
}

interface MessageEntry {
  type: "message";
  message: Message;
}
```

`MessageEntry` intentionally has no per-message `id` or `timestamp`. The message itself is the durable record; ordering is line order in the file. If we later need per-message metadata we'll add a sibling entry type rather than widen this one.

### Session Manager — standalone functions

The plan originally sketched a `SessionManager` interface. The implementation uses standalone functions: there's no state to carry, and the CLI holds the one `Session` it cares about directly.

```typescript
interface Session {
  id: string;
  header: SessionHeader;
  messages: Message[];
}

interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  timestamp: string;
  messageCount: number;
}

interface CreateSessionResult {
  session: Session;
  path: string;
  /** True when .tokenius/sessions/ did not exist before this call. */
  isFirstInProject: boolean;
}

function createSession(cwd: string, model: string): CreateSessionResult;
function appendMessage(cwd: string, sessionId: string, message: Message): void;
function setTitle(cwd: string, session: Session, title: string): void;
function loadSession(cwd: string, id: string): Session;
function listSessions(cwd: string): SessionSummary[];
function sessionPath(cwd: string, id: string): string;
```

A few shape choices worth naming:

- **`createSession` returns an `isFirstInProject` flag.** The manager doesn't print anything — the CLI decides whether to show the `.gitignore` hint. Keeps the manager pure and test-friendly.
- **`appendMessage` takes a `Message`, not a generic `SessionEntry`.** Messages are the only thing we ever append after the header; exposing a generic append is a footgun (nothing stops a caller from writing a second header).
- **All functions take `cwd` explicitly.** No module-level "current session" state; two concurrent sessions can't cross-contaminate.
- **`setTitle` is a new primitive** (not in the original plan) because the title arrives _after_ the first turn. It rewrites the header line atomically via write-tmp + rename, so a crash mid-write can never truncate the file.

### Session Title — Auto-generated

After the first turn completes, ask the same provider/model that ran the turn to summarize the first user message as a short title. Best-effort: any failure (network, abort, empty response, malformed stream) falls back to a truncated form of the message itself.

```typescript
function truncateForTitle(message: string): string;

async function generateSessionTitle(
  firstUserMessage: string,
  provider: Provider,
  model: string,
  signal?: AbortSignal,
): Promise<string>;
```

Implementation notes:

- Hard 10-second timeout (`AbortSignal.timeout`) composed with the caller's signal via `AbortSignal.any` so a hung provider can't block the post-turn flow.
- Sanitizes the model's output (strips surrounding quotes, trailing punctuation, whitespace).
- On empty or error output, returns `truncateForTitle(firstUserMessage)` — collapses whitespace, caps to 40 chars with an ellipsis, returns `(untitled)` for all-whitespace input.
- Reuses the session's model. A cheap-model router is a future optimization (Sprint 7+); at ~20 output tokens the cost is negligible.

### Writing Entries

```typescript
function appendMessage(cwd: string, sessionId: string, message: Message): void {
  const entry: MessageEntry = { type: "message", message };
  appendFileSync(sessionPath(cwd, sessionId), `${JSON.stringify(entry)}\n`);
}
```

All I/O is synchronous (`node:fs`). Files are small, the LLM call dominates, and sync keeps error handling and callsite ergonomics simple.

### Loading a Session

```typescript
function loadSession(cwd: string, id: string): Session {
  const text = readFileSync(sessionPath(cwd, id), "utf8");
  const lines = text.split("\n").filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l) as SessionEntry);

  const first = entries[0];
  if (!first || first.type !== "session") {
    throw new Error(`Session file missing header: ${sessionPath(cwd, id)}`);
  }

  const messages: Message[] = [];
  for (const entry of entries.slice(1)) {
    if (entry.type === "message") messages.push(entry.message);
  }
  return { id: first.id, header: first, messages };
}
```

### Listing Sessions

```typescript
function listSessions(cwd: string): SessionSummary[] {
  const dir = join(cwd, ".tokenius", "sessions");
  if (!existsSync(dir)) return [];

  const summaries: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const text = readFileSync(join(dir, f), "utf8");
      const lines = text.split("\n").filter(Boolean);
      const first = lines[0];
      if (!first) continue;
      const header = JSON.parse(first) as SessionHeader;
      summaries.push({
        id: header.id,
        title: header.title ?? "(untitled)",
        cwd: header.cwd,
        timestamp: header.timestamp,
        messageCount: lines.length - 1,
      });
    } catch {
      continue; // Skip malformed files rather than failing the whole listing.
    }
  }

  return summaries.toSorted((a, b) => b.timestamp.localeCompare(a.timestamp));
}
```

Listing is not filtered by `header.cwd` — files already live under `{cwd}/.tokenius/sessions/`, so the filesystem path is the scoping. A malformed file next to a good one shouldn't nuke `/sessions`; we skip and keep going.

---

## Layer 7: Skills

### Skill Definition

```typescript
interface Skill {
  name: string; // kebab-case, 1-64 chars
  description: string;
  content: string; // Full markdown content (body after frontmatter)
  path: string; // Source file path
}
```

### Discovery

Skills are discovered from `.tokenius/skills/` in the project directory.
Discovery runs **once per session** (not per turn) so the cached system
prompt prefix stays stable. Edits to `SKILL.md` only take effect in the
next session — same behavior as `AGENTS.md`.

A malformed `SKILL.md` is **skipped with a stderr warning** rather than
aborting session startup. One broken skill in a library of many shouldn't
lock the user out of their work; the warning is loud enough to notice, the
rest of the skills still load.

Results are sorted by name so the prompt prefix is deterministic across
runs (cache hygiene).

```typescript
function discoverSkills(cwd: string): Skill[] {
  const dir = join(cwd, ".tokenius", "skills");
  if (!existsSync(dir)) return [];

  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      skills.push(parseSkill(path));
    } catch (error) {
      console.warn(`[tokenius] Skipping skill "${entry.name}": ${(error as Error).message}`);
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
```

### SKILL.md Parsing

YAML frontmatter parsed via **gray-matter** rather than a hand-rolled
`key: value` split. Handles quoting, nested values, and block-scalar
multi-line strings cleanly, which matters the moment anyone writes
`description: |` across several lines. The SKILL.md contract is small
today (`name`, `description`) but YAML leaves room to grow without
another parser rewrite.

Name validation is strict: **kebab-case, 1-64 chars**. The same regex is
applied whether the name comes from frontmatter or the folder fallback,
so bad folders and bad overrides fail uniformly.

```typescript
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

function parseFrontmatter(source: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  try {
    const result = matter(source);
    return { frontmatter: (result.data ?? {}) as Record<string, unknown>, body: result.content };
  } catch (error) {
    throw new Error(`Malformed frontmatter: ${(error as Error).message}`, { cause: error });
  }
}

function parseSkill(path: string): Skill {
  const { frontmatter, body } = parseFrontmatter(readFileSync(path, "utf8"));

  const folderName = basename(dirname(path));
  const rawName = frontmatter.name ?? folderName;
  if (typeof rawName !== "string") {
    throw new TypeError(`Invalid skill name in ${path}: expected string, got ${typeof rawName}`);
  }
  if (rawName.length === 0 || rawName.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(rawName)) {
    throw new Error(
      `Invalid skill name "${rawName}" in ${path}: must be kebab-case and 1-${MAX_NAME_LENGTH} chars.`,
    );
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

  return { name: rawName, description, content: body.trim(), path };
}
```

### Skill Invocation

`applySkill` is a **pure** helper — no filesystem access. The CLI (Sprint 6)
parses `/skill:<name>` out of user input, looks the skill up in the list
already discovered at session start, and calls `applySkill` to produce the
final user message. This keeps discovery a once-per-session concern and
keeps invocation synchronous at the call site.

```typescript
function applySkill(skill: Skill, userPrompt: string): string {
  const trimmed = userPrompt.trim();
  if (trimmed.length === 0) return skill.content;
  return `${skill.content}\n\n---\n\nUser request: ${trimmed}`;
}
```

### Example Skill

```
.tokenius/skills/
  code-review/
    SKILL.md
```

```markdown
---
name: code-review
description: "Thorough code review with security and performance focus"
---

# Code Review Assistant

Review the provided code with focus on:

1. **Security** — injection vulnerabilities, auth issues, data exposure
2. **Performance** — unnecessary allocations, N+1 queries, missing indexes
3. **Maintainability** — naming, structure, complexity
4. **Error handling** — missing cases, swallowed errors

Format your review as:

- Critical (must fix)
- Warning (should fix)
- Suggestion (nice to have)
```

---

## Layer 8: Configuration & Project Rules

### `tokenius.json` Schema

No API keys in config — env vars only (via `.env` or shell environment).

Sprint 5 scope is **provider + model only**. The other fields below
(`maxTurns`, `permissions`) are on the future roadmap but deliberately
left out of the live schema until a consumer exists for them — carrying
unused config is worse than extending the schema later.

```typescript
// Sprint 5 (current)
interface TokeniusConfig {
  provider: ProviderId; // Default: "anthropic"
  model: string; // Default: "claude-sonnet-4-6"
}

const DEFAULT_CONFIG: TokeniusConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

// Future sprints will extend:
//   maxTurns?: number;                 // Override default per-agent maxTurns
//   permissions?: {
//     bash?: PermissionRule[];         // Glob patterns for allow/deny
//     blockedPaths?: string[];         // Additional blocked file paths
//   };
```

### Config Loading — Fail Fast

Zod validates the JSON shape in **strict** mode: unknown keys throw so
typos like `provders` can't silently fall back to defaults. When the user
specifies `model` but omits `provider`, the provider is **inferred** from
the model's metadata — prevents confusing "provider mismatch" errors
referencing a default value the user never wrote. Explicit mismatches
(both fields set, disagreeing) still error loudly and name both of the
user's own values.

```typescript
const ConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().optional(),
  })
  .strict();

function loadConfig(cwd: string): TokeniusConfig {
  const configPath = join(cwd, "tokenius.json");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in tokenius.json: ${(error as Error).message}`, { cause: error });
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    throw new Error(`Invalid tokenius.json at "${path}": ${issue?.message ?? "unknown error"}`);
  }

  const model = parsed.data.model ?? DEFAULT_CONFIG.model;

  let modelProvider: ProviderId;
  try {
    modelProvider = getModelMetadata(model).provider;
  } catch {
    throw new Error(`Unknown model "${model}" in tokenius.json.`);
  }

  if (parsed.data.provider && parsed.data.provider !== modelProvider) {
    throw new Error(
      `Model "${model}" belongs to provider "${modelProvider}", but tokenius.json sets provider to "${parsed.data.provider}".`,
    );
  }

  return { provider: modelProvider, model };
}
```

### API Key Resolution — Env Vars Only

```typescript
function resolveApiKey(provider: ProviderId): string {
  const envKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const value = process.env[envKey]; // Bun auto-loads .env
  if (!value) {
    throw new Error(`Missing ${envKey}. Set it in your environment or .env file.`);
  }
  return value;
}
```

### AGENTS.md Loading

Simple: load from project root if present.

```typescript
function loadAgentsMd(cwd: string): string | null {
  const agentsPath = join(cwd, "AGENTS.md");
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, "utf-8");
  }
  return null;
}
```

---

## Layer 9: CLI & TUI

### Phase 1: Simple CLI (Readline)

Start here. No dependencies beyond what Bun provides + chalk for colors.

```typescript
import { createInterface } from "readline";

async function main() {
  // Fail fast on bad config
  const config = loadConfig(process.cwd());
  const apiKey = resolveApiKey(config.provider);
  const provider = createProvider(config.provider, { apiKey });

  // Build system prompt ONCE (static for prompt caching)
  const systemPrompt = buildSystemPrompt(AGENTS.build, process.cwd());

  // Always start a new session
  const session = sessionManager.create(process.cwd(), config.model);

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Tokenius — type /help for commands, /quit to exit\n");

  // Abort controller for Ctrl+C handling
  let abortController = new AbortController();

  // First Ctrl+C aborts the loop, second kills the process
  let lastCtrlC = 0;
  process.on("SIGINT", () => {
    const now = Date.now();
    if (now - lastCtrlC < 1000) process.exit(0); // Double Ctrl+C = kill
    lastCtrlC = now;
    abortController.abort();
    abortController = new AbortController(); // Reset for next prompt
  });

  while (true) {
    const input = await question(rl, "> ");
    if (!input.trim()) continue;

    // Handle slash commands
    if (input.startsWith("/")) {
      await handleCommand(input, session);
      continue;
    }

    // Handle skill invocation: /skill:name rest of prompt
    let userMessage = input;
    if (input.startsWith("/skill:")) {
      const skillName = input.slice(7).split(" ")[0];
      const userPrompt = input.slice(7 + skillName.length).trim();
      userMessage = invokeSkill(skillName, userPrompt, process.cwd());
    }

    // Add user message
    session.messages.push({ role: "user", content: userMessage });

    // Run agent loop
    const result = await agentLoop({
      agent: AGENTS.build,
      provider,
      model: config.model,
      messages: session.messages,
      systemPrompt,
      tools: resolveTools(AGENTS.build),
      maxTurns: config.maxTurns ?? AGENTS.build.maxTurns,
      signal: abortController.signal,
      onEvent: (event) => renderEvent(event),
    });

    session.messages = result.messages;
    persistSession(session);
    printUsage(result.usage, config.model);

    // Generate title after first exchange
    if (!session.header.title) {
      session.header.title = await generateSessionTitle(input, provider, config.model);
      updateSessionHeader(session);
    }
  }
}
```

### Slash Commands

```typescript
const COMMANDS: Record<string, (args: string, session: Session) => Promise<void>> = {
  "/help": async () => {
    printHelp();
  },
  "/quit": async () => {
    process.exit(0);
  },
  "/sessions": async () => {
    listSessions(process.cwd());
  },
  "/load": async (id) => {
    /* load session by id, replace current */
  },
  "/cost": async (_, session) => {
    printSessionCost(session);
  },
  "/clear": async (_, session) => {
    session.messages = [];
  },
  "/model": async (model) => {
    /* validate and switch model */
  },
  "/skills": async () => {
    listAvailableSkills(process.cwd());
  },
  "/usage": async (_, session) => {
    printDetailedUsage(session);
  },
  "/replay": async (id) => {
    /* replay a saved session's messages without re-executing */
  },
};
```

### Streaming Output Rendering

```typescript
import chalk from "chalk";

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "thinking_delta":
      process.stdout.write(chalk.dim(event.thinking));
      break;
    case "tool_call_start":
      console.log(chalk.cyan(`\n> ${event.name}`));
      break;
    case "tool_result":
      if (event.result.isError) {
        console.log(chalk.red(`  x Error: ${event.result.content.slice(0, 200)}`));
      } else {
        console.log(chalk.green(`  Done (${event.result.content.length} chars)`));
      }
      break;
    case "turn_end":
      // Optionally show per-turn token count
      break;
    case "context_limit_reached":
      console.log(chalk.yellow("\nSession context full. Start a new session or use /clear."));
      break;
  }
}

function printUsage(usage: TokenUsage, model: string): void {
  const cost = calculateCost(model, usage);
  console.log(
    chalk.dim(`\n${usage.inputTokens + usage.outputTokens} tokens ($${cost.toFixed(4)})`),
  );
}
```

### Phase 2: TUI (Later)

When ready, replace the readline loop with a proper TUI. The agent loop and event system
don't change — only the rendering layer.

Key TUI features to add:

- Spinner during LLM response + tool execution
- Syntax highlighting for code blocks
- Split view (input at bottom, output scrolling above)
- Session info in status bar
- Permission confirmation dialogs
- Bash streaming output (upgrade from Phase 1 spinner)

---

## Testing Strategy

### Design Decision: Tests Live Next to Source

Test files are colocated with their source files as `*.test.ts`, consistent with the
existing project convention (see AGENTS.md: "test files live next to source as `*.test.ts`").
Run with `bun test`. No test framework dependencies — Bun's built-in test runner handles
`describe`, `it`, `expect`, and mocking.

### Unit Tests (Pure Functions)

Every pure function gets a test file. These are fast, deterministic, and provide the
highest signal-to-effort ratio.

```typescript
// src/tools/truncation.test.ts
import { describe, expect, it } from "bun:test";
import { truncateHead, truncateTail } from "./truncation";

describe("truncateHead", () => {
  it("returns content unchanged when under limits", () => {
    const result = truncateHead("line1\nline2\nline3");
    expect(result.wasTruncated).toBe(false);
    expect(result.content).toBe("line1\nline2\nline3");
  });

  it("truncates to MAX_LINES and appends metadata", () => {
    const input = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
    const result = truncateHead(input);
    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain("[Output truncated:");
    expect(result.originalLines).toBe(5000);
  });

  it("never cuts mid-line", () => {
    // Generate content that exceeds MAX_BYTES mid-line
    // Verify the cut happens at a line boundary
  });
});
```

**Functions that must have unit tests:**

| Module                          | Functions                                                             |
| ------------------------------- | --------------------------------------------------------------------- |
| `providers/cost.ts`             | `calculateCost`, `addUsage`                                           |
| `providers/models.ts`           | `getModelMetadata` (known model, unknown model)                       |
| `providers/partial-json.ts`     | `parsePartialJson`, `closeBrackets`                                   |
| `providers/retry.ts`            | `isRetryable`                                                         |
| `tools/truncation.ts`           | `truncateHead`, `truncateTail`                                        |
| `tools/validation.ts`           | `validateArgs` (valid, missing required, wrong type)                  |
| `tools/edit.ts`                 | edit logic (unique match, no match, multiple matches, `replace_all`)  |
| `security/path-validation.ts`   | `validatePath` (within cwd, outside cwd, blocked files, blocked dirs) |
| `security/command-detection.ts` | `checkCommand` (safe, blocked, requires confirmation)                 |
| `security/secrets-detection.ts` | `containsSecrets` (API keys, tokens, false positives)                 |
| `skills/parser.ts`              | `parseFrontmatter` (with frontmatter, without, malformed)             |
| `agent/context-tracker.ts`      | `isContextExhausted`, `estimateTokens`                                |
| `config/loader.ts`              | `loadConfig` (default, valid, invalid provider, unknown model)        |

### Integration Tests (Component Boundaries)

These test how components interact. They use mock providers (no real API calls)
and temporary file systems.

```typescript
// src/agent/loop.test.ts
import { describe, expect, it } from "bun:test";
import { agentLoop } from "./loop";

function createMockProvider(responses: AssistantMessage[]): Provider {
  let callIndex = 0;
  return {
    id: "anthropic",
    async *stream() {
      const response = responses[callIndex++];
      // Emit StreamEvents that reconstruct the response
      yield { type: "message_start" };
      for (const block of response.content) {
        if (block.type === "text") {
          yield { type: "text_delta", text: block.text };
        }
        if (block.type === "tool_call") {
          yield { type: "tool_call_start", id: block.id, name: block.name };
          yield { type: "tool_call_delta", arguments: JSON.stringify(block.arguments) };
          yield { type: "tool_call_end" };
        }
      }
      yield { type: "message_end", usage: response.usage, stopReason: response.stopReason };
    },
  };
}

describe("agentLoop", () => {
  it("terminates when LLM returns no tool calls", async () => {
    const provider = createMockProvider([
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
        usage: { inputTokens: 100, outputTokens: 10 },
        stopReason: "stop",
      },
    ]);

    const result = await agentLoop({
      agent: AGENTS.build,
      provider,
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Hi" }],
      systemPrompt: "You are helpful",
      tools: [],
      maxTurns: 10,
    });

    expect(result.turns).toBe(1);
  });

  it("executes tool calls and loops back", async () => {
    // First response: tool call → second response: text only
    // Verify: 2 turns, tool was executed, result appended
  });

  it("stops when context limit is exceeded", async () => {
    // Mock provider that returns high inputTokens
    // Verify: loop breaks, context_limit_reached event emitted
  });

  it("stops on abort signal", async () => {
    const controller = new AbortController();
    controller.abort();
    // Verify: loop exits immediately with 0 turns
  });
});
```

**Integration boundaries to test:**

| Test file                      | What it covers                                                      |
| ------------------------------ | ------------------------------------------------------------------- |
| `agent/loop.test.ts`           | Loop termination, tool execution, context limit, abort              |
| `agent/stream.test.ts`         | `streamResponse()` assembles events into AssistantMessage correctly |
| `agent/execute.test.ts`        | Tool validation errors, permission denied, sequential execution     |
| `security/permissions.test.ts` | Batch prompting, session memory, denied-tool-still-runs-others      |
| `session/manager.test.ts`      | Create → append → load roundtrip, list by cwd, sort order           |

### End-to-End Test

One test that wires up the entire system with a mock provider:

```typescript
// src/e2e.test.ts
import { describe, expect, it } from "bun:test";

describe("end-to-end", () => {
  it("handles a complete user interaction", async () => {
    // 1. Create a temp directory with a test file
    // 2. Set up mock provider that returns a read tool call, then a text response
    // 3. Run the full CLI flow programmatically (not readline — call the inner function)
    // 4. Verify: file was read, response was generated, session was persisted
    // 5. Load the session from disk, verify it roundtrips
  });
});
```

### Test Helpers

Shared test utilities to reduce boilerplate:

```typescript
// src/test-helpers.ts

// Creates a temp directory with files, returns cleanup function
function createTempProject(files: Record<string, string>): { cwd: string; cleanup: () => void };

// Creates a mock provider from a sequence of responses
function createMockProvider(responses: AssistantMessage[]): Provider;

// Creates a mock tool that records calls and returns a fixed result
function createMockTool(name: string, result: ToolResult): ToolDefinition & { calls: unknown[] };
```

---

## Observability & Debugging

### Debug Mode

Enabled via `--debug` CLI flag or `DEBUG=tokenius` environment variable. Logs raw
provider interactions and internal state to stderr so they don't interfere with
normal stdout output.

```typescript
const DEBUG = process.env.DEBUG === "tokenius" || process.argv.includes("--debug");

function debug(category: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
  console.error(`[${timestamp}] [${category}]`, ...args);
}
```

Usage throughout the codebase:

```typescript
// In provider — log raw request/response
debug("provider", "request", { model, messageCount: context.messages.length });
debug("provider", "response", { usage, stopReason });

// In agent loop — log turn progression
debug("loop", `turn ${turn}/${maxTurns}`, { inputTokens: tracker.lastKnownInputTokens });

// In tools — log execution
debug("tool", `executing ${tool.name}`, { args: call.arguments });
debug("tool", `result ${tool.name}`, { chars: result.content.length, isError: result.isError });

// In security — log decisions
debug("security", `path check: ${filePath}`, { valid, reason });
debug("security", `command check: ${command.slice(0, 80)}`, { allowed, requiresConfirmation });
```

### `/usage` Command — Detailed Session Stats

Goes beyond the per-turn cost display. Shows cumulative session statistics with
a breakdown by token type.

```typescript
function printDetailedUsage(session: Session, model: string): void {
  // Accumulate all usage from assistant messages in the session
  const totals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: 0,
    toolCalls: 0,
  };

  for (const msg of session.messages) {
    if (msg.role === "assistant" && msg.usage) {
      totals.inputTokens += msg.usage.inputTokens;
      totals.outputTokens += msg.usage.outputTokens;
      totals.cacheReadTokens += msg.usage.cacheReadTokens ?? 0;
      totals.cacheWriteTokens += msg.usage.cacheWriteTokens ?? 0;
      totals.turns++;
      totals.toolCalls += msg.content.filter((b) => b.type === "tool_call").length;
    }
  }

  const cost = calculateCost(model, totals);

  // Display:
  //   Session: abc123 (Fix auth bug)
  //   Model:   claude-sonnet-4-20250514
  //   Turns:   12 (47 tool calls)
  //   Tokens:  input 142,300 | output 8,200 | cache read 98,000 | cache write 44,300
  //   Cost:    $0.4821
  //   Context: 142k / 200k (71%)
}
```

### Context Window Indicator

After each turn, show how full the context window is. This gives the user
situational awareness about when the session will hit its limit.

```typescript
function formatContextIndicator(tracker: ContextTracker): string {
  const used = Math.round(tracker.lastKnownInputTokens / 1000);
  const total = Math.round(tracker.contextWindow / 1000);
  const pct = Math.round((tracker.lastKnownInputTokens / tracker.contextWindow) * 100);

  // Color based on fullness: green < 50%, yellow 50-80%, red > 80%
  const color = pct < 50 ? chalk.green : pct < 80 ? chalk.yellow : chalk.red;
  return color(`[${used}k / ${total}k tokens]`);
}

// Shown after each turn in the renderer:
//   Done (2,431 chars) [42k / 200k tokens]
```

---

## CI/CD & Distribution

### GitHub Actions — CI Pipeline

Run the full check suite on every push and pull request. Mirrors the local
pre-commit hook: lint, format, typecheck, knip, tests.

```yaml
# .github/workflows/ci.yml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest

      - run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Format check
        run: bun run format:check

      - name: Typecheck
        run: bun run typecheck

      - name: Knip (unused exports)
        run: bun run knip

      - name: Tests
        run: bun test
```

### Branch Protection

After the CI workflow is live, enable branch protection on `main`:

- Require CI to pass before merge
- Require PR reviews (even if self-reviewed — the habit matters for portfolio)

### Distribution — Making It Installable

The `package.json` `bin` field makes the package runnable as a CLI.

```jsonc
// package.json additions
{
  "name": "tokenius",
  "version": "0.1.0",
  "description": "A lightweight coding agent harness. Single-process TypeScript + Bun.",
  "keywords": ["ai", "agent", "coding-assistant", "cli", "llm"],
  "bin": {
    "tokenius": "./dist/index.js",
  },
  "files": ["dist"],
  "type": "module",
  "license": "MIT",
}
```

**Build produces a single file:**

```typescript
// bunfig.toml or bun build command
// bun build src/index.ts --outdir dist --target bun --minify
```

**Install paths:**

```bash
# From npm (after publishing)
bun add -g tokenius
npx tokenius

# From source
git clone ... && cd tokenius && bun install && bun link
```

### CLI Flags

```typescript
// src/cli/args.ts
interface CLIArgs {
  version: boolean; // --version
  help: boolean; // --help
  debug: boolean; // --debug
}

function parseArgs(): CLIArgs {
  return {
    version: process.argv.includes("--version"),
    help: process.argv.includes("--help"),
    debug: process.argv.includes("--debug"),
  };
}

// In main():
const args = parseArgs();
if (args.version) {
  const pkg = await Bun.file("package.json").json();
  console.log(`tokenius v${pkg.version}`);
  process.exit(0);
}
if (args.help) {
  printHelp();
  process.exit(0);
}
```

---

## Documentation & Portfolio

### README.md

The README is the landing page. It should take < 30 seconds to understand what
Tokenius is and see it in action.

**Structure:**

```markdown
# Tokenius

One-line pitch: what it is, what makes it different.

## Demo

<!-- Terminal recording (asciinema or vhs) embedded as GIF or SVG -->

## Install

## Quick Start

## Architecture

<!-- The ASCII diagram from this doc -->

## Design Decisions

Link to docs/DECISIONS.md for the full rationale.

## Development

## License
```

**Key rules:**

- Demo goes above the fold (before install instructions)
- No walls of text — use the architecture doc for details, keep README scannable
- Show a real interaction, not a contrived hello-world

### Terminal Recording

Use [vhs](https://github.com/charmbracelet/vhs) (preferred — deterministic, scriptable)
or [asciinema](https://asciinema.org/) for the demo recording.

```tape
# demo.tape — vhs script
Output demo.gif
Set Width 1200
Set Height 600
Set Theme "Catppuccin Mocha"

Type "tokenius"
Enter
Sleep 1s

Type "Read the README and suggest improvements"
Enter
Sleep 8s
# ... capture the streaming output, tool calls, final response
```

**Record after Sprint 7** when the CLI is functional. Re-record when TUI lands.

### docs/DECISIONS.md

Document the _why_ behind every non-obvious design choice. This is what separates
"I followed a tutorial" from "I thought deeply about tradeoffs." Each entry follows
the same structure:

```markdown
## Decision: No Context Compaction

**Status:** Accepted

**Context:** When the context window fills up, the agent can no longer make LLM calls.
Other agents (Claude Code, Cursor) handle this by compacting — summarizing older messages
with a cheap model and replacing them.

**Decision:** Hard stop. The session ends. User starts fresh or uses /clear.

**Rationale:**

- Compaction requires a cut-point heuristic (which messages to keep?) — easy to get wrong
- LLM summarization loses detail, especially tool results and code snippets
- Cheap-model routing adds a second model dependency and cost tracking path
- For a learning project, simplicity > marginal UX improvement
- 200k tokens is ~50k words — most coding sessions fit comfortably

**Tradeoff:** Long sessions (large refactors, multi-file changes) will hit the limit.
The user must develop a habit of scoped sessions.
```

**Decisions to document:**

| Decision                              | Key tradeoff                            |
| ------------------------------------- | --------------------------------------- |
| No compaction                         | Simplicity vs. session length           |
| Anthropic-native canonical format     | Fewer conversions vs. vendor coupling   |
| Sequential tool execution             | Simplicity vs. throughput               |
| JSONL persistence                     | Simplicity vs. queryability             |
| No plugin system for tools            | Focus vs. extensibility                 |
| Security-by-design (wired into tools) | Upfront effort vs. bolt-on risk         |
| Direct SDK usage (no LangChain)       | Control vs. convenience                 |
| Hard-coded model metadata             | Simplicity vs. auto-discovery           |
| Bun-only runtime                      | Speed + batteries vs. Node.js ecosystem |

### `/replay` Command

Replay a saved session's messages in the terminal without re-executing tool calls
or making API requests. Useful for demos and reviewing past sessions.

```typescript
async function replaySession(sessionId: string): Promise<void> {
  const session = loadSession(sessionId);

  for (const msg of session.messages) {
    switch (msg.role) {
      case "user":
        console.log(chalk.blue(`\n> ${msg.content}\n`));
        break;
      case "assistant":
        for (const block of msg.content) {
          if (block.type === "text") {
            // Simulate streaming with a small delay per character
            for (const char of block.text) {
              process.stdout.write(char);
              await Bun.sleep(5); // 5ms per char — fast but visible
            }
          }
          if (block.type === "tool_call") {
            console.log(chalk.cyan(`\n> ${block.name}`));
            console.log(chalk.dim(JSON.stringify(block.arguments, null, 2)));
          }
        }
        break;
      case "tool_result":
        const color = msg.isError ? chalk.red : chalk.green;
        console.log(color(`  ${msg.content.slice(0, 200)}`));
        break;
    }
  }

  console.log(
    chalk.dim(`\nReplayed ${session.messages.length} messages from session ${sessionId}`),
  );
}
```

---

## Implementation Order

Build bottom-up. Each sprint produces a working, testable increment. Security is wired
into each tool as it's built — not bolted on after the fact.

### Sprint 1: Foundation (days 1-3)

| #   | Task                                                   | Test                               |
| --- | ------------------------------------------------------ | ---------------------------------- |
| 1.1 | Define all core types in `src/types.ts`                | — (types only)                     |
| 1.2 | Model metadata in `src/providers/models.ts`            | `getModelMetadata` known + unknown |
| 1.3 | Cost calculation in `src/providers/cost.ts`            | `calculateCost`, `addUsage`        |
| 1.4 | Provider types in `src/providers/types.ts`             | — (types only)                     |
| 1.5 | Anthropic provider in `src/providers/anthropic.ts`     | — (tested via smoke test)          |
| 1.6 | Provider registry in `src/providers/registry.ts`       | — (trivial Map wrapper)            |
| 1.7 | Retry logic in `src/providers/retry.ts`                | `isRetryable` unit tests           |
| 1.8 | Partial JSON parser in `src/providers/partial-json.ts` | Extensive edge case tests          |
| 1.9 | Smoke test — hardcoded prompt → stream to stdout       | Manual verification                |

**Milestone:** Can send a prompt to Claude and stream the response to the terminal.

### Sprint 2: Tools + Security (days 4-7)

Security is built alongside each tool, not retroactively.

| #    | Task                                                     | Test                                             |
| ---- | -------------------------------------------------------- | ------------------------------------------------ |
| 2.1  | Tool types in `src/tools/types.ts`                       | — (types only)                                   |
| 2.2  | Tool registry in `src/tools/registry.ts`                 | Schema sorting determinism                       |
| 2.3  | Truncation in `src/tools/truncation.ts`                  | Head/tail, limits, mid-line safety               |
| 2.4  | Arg validation in `src/tools/validation.ts`              | Valid, missing required, wrong type              |
| 2.5  | Path validation in `src/security/path-validation.ts`     | Within cwd, outside, blocked files/dirs          |
| 2.6  | Secrets detection in `src/security/secrets-detection.ts` | API keys, tokens, false positives                |
| 2.7  | Command detection in `src/security/command-detection.ts` | Safe, blocked, confirmation patterns             |
| 2.8  | `read` tool (with path validation, binary detection)     | Read file, offset/limit, binary, blocked path    |
| 2.9  | `grep` tool (with path validation)                       | Pattern match, include filter, rg fallback       |
| 2.10 | `glob` tool (with path validation)                       | Pattern match, sorted output                     |
| 2.11 | `bash` tool (with command detection, timeout)            | Execution, timeout kill, blocked command         |
| 2.12 | `write` tool (with path validation, secrets detection)   | Create, overwrite, mkdir -p, blocked secret      |
| 2.13 | `edit` tool (with path + secrets, replace_all)           | Unique match, no match, multi-match, replace_all |

**Milestone:** All 6 core tools work with security enforced. Can read, write, search, and execute.

### Sprint 3: Agent Loop (days 8-10)

| #   | Task                                                  | Test                                             |
| --- | ----------------------------------------------------- | ------------------------------------------------ |
| 3.1 | Context tracker in `src/agent/context-tracker.ts`     | `isContextExhausted`, `estimateTokens`           |
| 3.2 | Stream accumulator in `src/agent/stream.ts`           | Events → AssistantMessage assembly               |
| 3.3 | Tool execution in `src/agent/execute.ts`              | Validation errors, permission denied, sequential |
| 3.4 | Permission prompts in `src/security/permissions.ts`   | Batch prompting, session memory                  |
| 3.5 | Agent loop in `src/agent/loop.ts`                     | Termination, tool exec, context limit, abort     |
| 3.6 | Agent configs in `src/agent/agents.ts`                | — (static data)                                  |
| 3.7 | System prompt builder in `src/agent/system-prompt.ts` | With/without AGENTS.md, with/without skills      |
| 3.8 | `spawn_agent` tool in `src/tools/spawn-agent.ts`      | Subagent invocation, cost display                |
| 3.9 | End-to-end test with mock provider                    | Full loop: user msg → tools → response → session |

**Milestone:** The agent loop works end-to-end with a mock provider. Tool calls, security, context tracking all wired together.

### Sprint 4: Persistence (days 11-12)

| #   | Task                                               | Test                                         |
| --- | -------------------------------------------------- | -------------------------------------------- |
| 4.1 | Session types in `src/session/types.ts`            | — (types only)                               |
| 4.2 | Session manager in `src/session/manager.ts`        | Create → append → load roundtrip, list, sort |
| 4.3 | Session title generation in `src/session/title.ts` | — (LLM call, tested manually)                |
| 4.4 | First-run `.gitignore` hint                        | — (manual verification)                      |

**Milestone:** Sessions persist to disk and can be loaded back.

### Sprint 5: Config & Skills (days 13-14)

| #   | Task                                           | Test                                            |
| --- | ---------------------------------------------- | ----------------------------------------------- |
| 5.1 | Config loader in `src/config/loader.ts`        | Default, valid, invalid provider, unknown model |
| 5.2 | API key resolution in `src/config/api-keys.ts` | Present, missing                                |
| 5.3 | AGENTS.md loader in `src/config/agents-md.ts`  | Present, missing                                |
| 5.4 | Skill parser in `src/skills/parser.ts`         | With frontmatter, without, malformed            |
| 5.5 | Skill discovery in `src/skills/discovery.ts`   | Directory with skills, empty, missing           |
| 5.6 | Skill invocation                               | `/skill:name` → prepended content               |

**Milestone:** Config, project rules, and skills all load and integrate with the agent.

### Sprint 6: CLI (days 15-17)

| #   | Task                                              | Test                             |
| --- | ------------------------------------------------- | -------------------------------- |
| 6.1 | CLI args parser in `src/cli/args.ts`              | `--version`, `--help`, `--debug` |
| 6.2 | Streaming renderer in `src/cli/renderer.ts`       | — (visual, tested manually)      |
| 6.3 | Context window indicator                          | — (visual, tested manually)      |
| 6.4 | Slash commands in `src/cli/commands.ts`           | — (tested via integration)       |
| 6.5 | Debug mode in `src/debug.ts`                      | — (tested via `--debug` flag)    |
| 6.6 | Main CLI loop in `src/cli/index.ts`               | — (tested manually)              |
| 6.7 | Bootstrap in `src/index.ts`                       | — (entry point wiring)           |
| 6.8 | Startup banner (model, provider, cwd, session ID) | — (visual)                       |

**Milestone:** Fully functional CLI. Can have real conversations with the agent.

### Sprint 7: Polish (days 18-20)

| #   | Task                                                  | Test                     |
| --- | ----------------------------------------------------- | ------------------------ |
| 7.1 | OpenAI provider in `src/providers/openai.ts`          | — (tested with real API) |
| 7.2 | `/usage` command (detailed stats)                     | — (tested manually)      |
| 7.3 | `/replay` command                                     | — (tested manually)      |
| 7.4 | Error handling pass — network, empty responses, abort | Edge case tests          |
| 7.5 | Missing ripgrep graceful fallback                     | Fallback grep works      |
| 7.6 | First-run experience — missing API key message        | — (tested manually)      |

**Milestone:** Production-quality CLI with two providers and polished error handling.

### Sprint 8: Documentation & CI (days 21-23)

| #   | Task                                                          |
| --- | ------------------------------------------------------------- |
| 8.1 | GitHub Actions CI workflow (`.github/workflows/ci.yml`)       |
| 8.2 | Branch protection on `main`                                   |
| 8.3 | `package.json` — bin, files, keywords, description            |
| 8.4 | README.md — pitch, architecture diagram, install, quick start |
| 8.5 | Terminal demo recording (vhs or asciinema)                    |
| 8.6 | `docs/DECISIONS.md` — all 9 design decision entries           |

**Milestone:** Portfolio-ready. Anyone can clone, install, use, and understand why it works the way it does.

### Sprint 9: TUI (future)

| #   | Task                                            |
| --- | ----------------------------------------------- |
| 9.1 | Choose TUI framework (Ink or custom)            |
| 9.2 | Spinners during LLM response + tool execution   |
| 9.3 | Syntax highlighting for code blocks             |
| 9.4 | Split view (input bottom, output scrolling top) |
| 9.5 | Permission confirmation dialogs as proper UI    |

---

## Directory Structure

```
tokenius/
  src/
    index.ts                     # Entry point — bootstrap and start CLI
    types.ts                     # All shared type definitions
    debug.ts                     # Debug logging (stderr, gated by --debug)
    test-helpers.ts              # Shared test utilities (mock provider, temp dirs)
    e2e.test.ts                  # End-to-end test with mock provider

    providers/
      types.ts                   # Provider, StreamEvent, LLMContext
      registry.ts                # Provider registry
      anthropic.ts               # Anthropic SDK → StreamEvent
      openai.ts                  # OpenAI SDK → StreamEvent (also covers xAI, GLM, etc.)
      models.ts                  # Hardcoded model metadata (pricing, context, capabilities)
      models.test.ts
      retry.ts                   # streamWithRetry, exponential backoff
      retry.test.ts
      cost.ts                    # calculateCost, addUsage
      cost.test.ts
      partial-json.ts            # parsePartialJson, closeBrackets
      partial-json.test.ts

    tools/
      types.ts                   # ToolDefinition, ToolResult, ToolContext
      registry.ts                # Tool registry + getToolSchemas (sorted for caching)
      truncation.ts              # truncateHead, truncateTail
      truncation.test.ts
      validation.ts              # JSON Schema arg validation
      validation.test.ts
      read.ts
      read.test.ts
      write.ts
      write.test.ts
      edit.ts                    # Includes replace_all support
      edit.test.ts
      bash.ts                    # Timeout, process kill
      bash.test.ts
      grep.ts                    # ripgrep with manual fallback
      grep.test.ts
      glob.ts
      glob.test.ts
      spawn-agent.ts

    agent/
      loop.ts                    # agentLoop() — the core algorithm
      loop.test.ts
      stream.ts                  # streamResponse() — accumulate stream
      stream.test.ts
      execute.ts                 # validateToolCalls + executeToolsSequential
      execute.test.ts
      agents.ts                  # Built-in agent configs (build, plan, explore)
      system-prompt.ts           # buildSystemPrompt() — static per session
      system-prompt.test.ts
      context-tracker.ts         # Token tracking from real provider usage
      context-tracker.test.ts

    security/
      path-validation.ts         # validatePath()
      path-validation.test.ts
      command-detection.ts       # checkCommand()
      command-detection.test.ts
      secrets-detection.ts       # containsSecrets()
      secrets-detection.test.ts
      permissions.ts             # Batch permission prompts, session memory
      permissions.test.ts

    session/
      types.ts                   # SessionEntry, SessionHeader
      manager.ts                 # create, list, load, append
      manager.test.ts
      title.ts                   # Auto-generate session title via LLM

    skills/
      discovery.ts               # discoverSkills()
      discovery.test.ts
      parser.ts                  # parseFrontmatter, parseSkill
      parser.test.ts

    config/
      loader.ts                  # loadConfig() — fail fast validation
      loader.test.ts
      api-keys.ts                # resolveApiKey() — env vars only
      agents-md.ts               # loadAgentsMd()

    cli/
      index.ts                   # Main readline loop, Ctrl+C handling
      args.ts                    # CLI argument parsing
      commands.ts                # Slash command handlers
      renderer.ts                # Streaming output rendering (chalk)

  docs/
    architecture-v3.md           # This document
    DECISIONS.md                 # Design decision records
    TYPESCRIPT.md                # TypeScript style rules
    BUN_APIS.md                  # Preferred Bun APIs

  .github/
    workflows/
      ci.yml                     # Lint, format, typecheck, knip, tests

  .tokenius/
    skills/                      # Project skills (committed)
    sessions/                    # Session files (gitignored)
```
