# Tokenius — Technical Architecture v2

A lightweight, well-designed coding agent harness. Single-process TypeScript + Bun.

**Revision notes:** This version incorporates all decisions from the design review session.
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
12. [Implementation Order](#implementation-order)
13. [Directory Structure](#directory-structure)

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

type ProviderId = "anthropic" | "openai"

interface ProviderConfig {
  apiKey: string
  baseUrl?: string
}

interface Provider {
  id: ProviderId
  stream(model: string, context: LLMContext, signal?: AbortSignal): AsyncIterable<StreamEvent>
}

// --- Context sent to LLM ---

interface LLMContext {
  systemPrompt: string
  messages: Message[]
  tools: ToolSchema[]
  maxTokens: number
}

// --- Messages ---

type Message = UserMessage | AssistantMessage | ToolResultMessage

interface UserMessage {
  role: "user"
  content: string
}

interface AssistantMessage {
  role: "assistant"
  content: AssistantContent[]
  usage?: TokenUsage
  stopReason?: "stop" | "tool_use" | "length" | "error"
}

interface ToolResultMessage {
  role: "tool_result"
  toolCallId: string
  toolName: string
  content: string
  isError?: boolean
}

// --- Assistant content blocks ---

type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock

interface TextBlock {
  type: "text"
  text: string
}

interface ThinkingBlock {
  type: "thinking"
  thinking: string
}

interface ToolCallBlock {
  type: "tool_call"
  id: string
  name: string
  arguments: Record<string, unknown>
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
  | { type: "error"; error: Error }

// --- Token tracking ---

interface TokenUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}
```

### Model Metadata (Hardcoded)

Single source of truth for pricing, context windows, and capabilities.
Updated when new models ship. ~30 lines for 2 providers.

```typescript
interface ModelMetadata {
  id: string
  provider: ProviderId
  contextWindow: number
  maxOutputTokens: number
  pricing: ModelPricing
  supportsCaching: boolean
}

interface ModelPricing {
  input: number   // Cost per 1M tokens
  output: number
  cacheRead?: number
  cacheWrite?: number
}

const MODELS: Record<string, ModelMetadata> = {
  "claude-sonnet-4-20250514": {
    id: "claude-sonnet-4-20250514",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    supportsCaching: true,
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 16_384,
    pricing: { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
    supportsCaching: true,
  },
  "gpt-4o": {
    id: "gpt-4o",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 2.5, output: 10 },
    supportsCaching: false,
  },
  "gpt-4o-mini": {
    id: "gpt-4o-mini",
    provider: "openai",
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    pricing: { input: 0.15, output: 0.6 },
    supportsCaching: false,
  },
}

function getModelMetadata(model: string): ModelMetadata {
  const meta = MODELS[model]
  if (!meta) throw new Error(`Unknown model: ${model}. Add it to MODELS in models.ts`)
  return meta
}
```

### Token Cost Calculation

```typescript
function calculateCost(model: string, usage: TokenUsage): number {
  const meta = MODELS[model]
  if (!meta) return 0
  const { pricing } = meta
  return (
    (usage.inputTokens * pricing.input) / 1_000_000 +
    (usage.outputTokens * pricing.output) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? 0)) / 1_000_000 +
    ((usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? 0)) / 1_000_000
  )
}
```

### Provider Implementation Pattern

Each provider is a single file that implements the `Provider` interface. It translates
the provider's SDK stream into the common `StreamEvent` type.

```typescript
// src/providers/anthropic.ts
import Anthropic from "@anthropic-ai/sdk"

export function createAnthropicProvider(config: ProviderConfig): Provider {
  const client = new Anthropic({ apiKey: config.apiKey })

  return {
    id: "anthropic",
    async *stream(model, context, signal) {
      const stream = client.messages.stream({
        model,
        system: context.systemPrompt,
        messages: convertMessages(context.messages),  // Map to Anthropic format (nearly 1:1)
        tools: convertTools(context.tools),
        max_tokens: context.maxTokens,
      }, { signal })

      for await (const event of stream) {
        yield mapToStreamEvent(event)  // Normalize to common StreamEvent
      }
    },
  }
}
```

```typescript
// src/providers/openai.ts — also works for xAI, GLM, Kimi, DeepSeek via baseUrl
import OpenAI from "openai"

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })

  return {
    id: "openai",
    async *stream(model, context, signal) {
      const stream = await client.chat.completions.create({
        model,
        messages: convertMessages(context.messages),   // Reshape content blocks → tool_calls array
        tools: convertTools(context.tools),
        max_tokens: context.maxTokens,
        stream: true,
      }, { signal })

      for await (const chunk of stream) {
        yield mapToStreamEvent(chunk)  // Normalize to common StreamEvent
      }
    },
  }
}
```

### Provider Registry

```typescript
// src/providers/registry.ts
const providers = new Map<ProviderId, Provider>()

function registerProvider(provider: Provider): void {
  providers.set(provider.id, provider)
}

function getProvider(id: ProviderId): Provider {
  const provider = providers.get(id)
  if (!provider) throw new Error(`Unknown provider: ${id}`)
  return provider
}
```

### Partial JSON Parsing

Tool arguments arrive incrementally during streaming. Accumulate the string and
parse on `tool_call_end`:

```typescript
function parsePartialJson<T>(incomplete: string): T {
  try {
    return JSON.parse(incomplete)
  } catch {
    // Attempt to close open braces/brackets for partial parsing
    return partialParse(incomplete)
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
}

async function* streamWithRetry(
  provider: Provider,
  model: string,
  context: LLMContext,
  signal?: AbortSignal,
): AsyncIterable<StreamEvent> {
  let lastError: Error | undefined

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      yield* provider.stream(model, context, signal)
      return  // Success
    } catch (error) {
      lastError = error as Error
      if (!isRetryable(error) || attempt === RETRY_CONFIG.maxRetries) break
      const delay = RETRY_CONFIG.baseDelayMs * 2 ** attempt  // 1s, 2s, 4s
      await Bun.sleep(delay)
    }
  }

  // Discard partial stream on failure — the LLM can regenerate
  throw lastError
}

function isRetryable(error: unknown): boolean {
  if (error instanceof Error) {
    // Rate limit or server errors
    const status = (error as { status?: number }).status
    if (status && RETRY_CONFIG.retryableStatuses.includes(status)) return true
    // Network errors
    if (error.message.includes("ECONNRESET") || error.message.includes("fetch failed")) return true
  }
  return false
}
```

### Context Limit Check

No compaction. Hard stop when context is full. Uses **real token counts** from
provider responses, not estimation.

```typescript
const CONTEXT_RESERVE = 20_000  // Space for system prompt + tools + response

interface ContextTracker {
  lastKnownInputTokens: number  // From most recent provider response
  contextWindow: number          // From model metadata
}

function isContextExhausted(tracker: ContextTracker): boolean {
  return tracker.lastKnownInputTokens > tracker.contextWindow - CONTEXT_RESERVE
}

// Called after each LLM response:
function updateTokenTracking(tracker: ContextTracker, usage: TokenUsage): void {
  tracker.lastKnownInputTokens = usage.inputTokens
}

// Fallback estimation for the very first message (no prior usage data):
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
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
  name: string
  description: string                    // Shown to LLM
  parameters: JsonSchema                 // JSON Schema for validation
  execute: (
    params: TParams,
    context: ToolContext,
  ) => Promise<ToolResult>
}

interface ToolContext {
  cwd: string                            // Working directory
  signal: AbortSignal                    // Cancellation
}

interface ToolResult {
  content: string
  isError?: boolean
}

type JsonSchema = {
  type: "object"
  properties: Record<string, unknown>
  required?: string[]
}
```

### Tool Registry

Tools are registered at startup. Schemas are sorted deterministically for prompt caching.

```typescript
const tools = new Map<string, ToolDefinition>()

function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool)
}

function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name)
}

function getToolSchemas(allowedTools: string[]): ToolSchema[] {
  return allowedTools
    .sort()  // Deterministic order for prompt caching
    .map((name) => tools.get(name))
    .filter(Boolean)
    .map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    }))
}
```

### Output Truncation (Mandatory)

Every tool result passes through truncation before reaching the LLM:

```typescript
const MAX_LINES = 2000
const MAX_BYTES = 50_000  // 50KB

interface TruncationResult {
  content: string
  wasTruncated: boolean
  originalLines: number
  originalBytes: number
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

Use Bun-compatible JSON Schema validation (AJV or a lightweight alternative):

```typescript
function validateArgs(schema: JsonSchema, args: unknown): { valid: boolean; errors?: string[] } {
  // Validate args against JSON schema
  // Return structured errors for the LLM
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
    command: string,      // Required. Shell command to run
    timeout?: number,     // Max execution time in ms (default: 120_000)
  },
  // Execution: Bun.spawn with shell
  // Output: combined stdout+stderr, shown to user AFTER completion (spinner while running)
  // Truncation: truncateTail (errors at bottom)
  // Cleanup: kill process on timeout/abort
  // Security: dangerous command detection (Layer 5)
}
```

#### `grep` — Search file contents

```typescript
{
  name: "grep",
  parameters: {
    pattern: string,      // Required. Regex pattern
    path?: string,        // Directory to search (default: cwd)
    include?: string,     // Glob filter (e.g., "*.ts")
  },
  // Implementation: Bun.spawn ripgrep (rg) if available, fallback to manual
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
  },
  // Implementation: Bun.Glob
  // Returns: sorted file paths
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
  agent: AgentConfig               // Which agent (build, plan, explore)
  provider: Provider               // LLM provider
  model: string                    // Model ID
  messages: Message[]              // Conversation history
  systemPrompt: string             // Assembled once at session start (static for caching)
  tools: ToolDefinition[]          // Available tools for this agent
  maxTurns: number                 // Safety limit
  signal?: AbortSignal             // Cancellation (Ctrl+C)
  onEvent?: (event: AgentEvent) => void  // Progress callback for UI
}

interface AgentLoopResult {
  messages: Message[]              // Updated message history
  usage: TokenUsage                // Accumulated token usage
  turns: number                    // How many LLM calls were made
}
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
  | { type: "error"; error: Error }
```

### The Loop

```typescript
async function agentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { agent, provider, model, messages, systemPrompt, tools, maxTurns, signal, onEvent } = config
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let turn = 0

  const modelMeta = getModelMetadata(model)
  const contextTracker: ContextTracker = {
    lastKnownInputTokens: 0,
    contextWindow: modelMeta.contextWindow,
  }

  while (turn < maxTurns) {
    // 0. Check abort
    if (signal?.aborted) break

    // 1. Check context limit
    if (isContextExhausted(contextTracker)) {
      onEvent?.({ type: "context_limit_reached" })
      break
    }

    turn++
    onEvent?.({ type: "turn_start", turn })

    // 2. Build LLM context
    const context: LLMContext = {
      systemPrompt,
      messages,
      tools: getToolSchemas(agent.tools),
      maxTokens: modelMeta.maxOutputTokens,
    }

    // 3. Stream LLM response (with retry)
    let assistantMessage: AssistantMessage
    try {
      assistantMessage = await streamResponse(provider, model, context, signal, onEvent)
    } catch (error) {
      onEvent?.({ type: "error", error: error as Error })
      break
    }

    messages.push(assistantMessage)
    totalUsage = addUsage(totalUsage, assistantMessage.usage)
    updateTokenTracking(contextTracker, assistantMessage.usage)
    onEvent?.({ type: "turn_end", usage: assistantMessage.usage })

    // 4. Check stop condition
    const toolCalls = extractToolCalls(assistantMessage)
    if (toolCalls.length === 0) break  // Done — no more tool calls

    // 5. Validate all tool calls, batch permission prompts upfront
    const validated = await validateToolCalls(toolCalls, tools, onEvent)

    // 6. Execute tools sequentially
    const toolResults = await executeToolsSequential(validated, tools, signal, onEvent)
    messages.push(...toolResults)
  }

  return { messages, usage: totalUsage, turns: turn }
}
```

### `streamResponse` — Accumulate Stream into AssistantMessage

```typescript
async function streamResponse(
  provider: Provider,
  model: string,
  context: LLMContext,
  signal: AbortSignal | undefined,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<AssistantMessage> {
  const content: AssistantContent[] = []
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: string = "stop"
  let currentToolArgs = ""

  // streamWithRetry handles network errors and rate limits (3x backoff)
  for await (const event of streamWithRetry(provider, model, context, signal)) {
    switch (event.type) {
      case "text_delta":
        appendToLastTextBlock(content, event.text)
        onEvent?.({ type: "text_delta", text: event.text })
        break

      case "thinking_delta":
        appendToLastThinkingBlock(content, event.thinking)
        onEvent?.({ type: "thinking_delta", thinking: event.thinking })
        break

      case "tool_call_start":
        content.push({ type: "tool_call", id: event.id, name: event.name, arguments: {} })
        currentToolArgs = ""
        onEvent?.({ type: "tool_call_start", name: event.name, id: event.id })
        break

      case "tool_call_delta":
        currentToolArgs += event.arguments
        onEvent?.({ type: "tool_call_args", name: "", partialArgs: currentToolArgs })
        break

      case "tool_call_end": {
        const lastToolCall = content.at(-1) as ToolCallBlock
        lastToolCall.arguments = parsePartialJson(currentToolArgs)
        break
      }

      case "message_end":
        usage = event.usage
        stopReason = event.stopReason
        break

      case "error":
        throw event.error
    }
  }

  return { role: "assistant", content, usage, stopReason }
}
```

### Sequential Tool Execution

Tools are executed one at a time. Permission prompts are batched upfront
during validation (before any execution begins).

```typescript
async function validateToolCalls(
  toolCalls: ToolCallBlock[],
  tools: ToolDefinition[],
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<ValidatedToolCall[]> {
  const results: ValidatedToolCall[] = []
  const permissionsNeeded: PermissionRequest[] = []

  // Phase 1: Validate all calls, collect permission requests
  for (const call of toolCalls) {
    const tool = getTool(call.name)
    if (!tool) {
      results.push({ call, tool: null, error: `Unknown tool: ${call.name}` })
      continue
    }

    const validation = validateArgs(tool.parameters, call.arguments)
    if (!validation.valid) {
      results.push({ call, tool, error: validation.errors.join("\n") })
      continue
    }

    const security = checkToolPermission(call)
    if (security.blocked) {
      results.push({ call, tool, error: security.reason })
      continue
    }

    if (security.requiresConfirmation) {
      permissionsNeeded.push({ tool: call.name, description: describeToolCall(call), reason: security.reason })
    }

    results.push({ call, tool })
  }

  // Phase 2: Batch permission prompt (one prompt for all dangerous operations)
  if (permissionsNeeded.length > 0) {
    const responses = await promptPermissions(permissionsNeeded)
    // Mark denied calls as errors
    for (const [i, response] of responses.entries()) {
      if (response === "deny") {
        const idx = results.findIndex((r) => r.call.name === permissionsNeeded[i].tool && !r.error)
        if (idx !== -1) results[idx].error = "User denied permission"
      }
    }
  }

  return results
}

async function executeToolsSequential(
  validated: ValidatedToolCall[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<ToolResultMessage[]> {
  const results: ToolResultMessage[] = []

  for (const v of validated) {
    if (v.error) {
      results.push({
        role: "tool_result",
        toolCallId: v.call.id,
        toolName: v.call.name,
        content: v.error,
        isError: true,
      })
      continue
    }

    onEvent?.({ type: "tool_call_start", name: v.call.name, id: v.call.id })

    const result = await v.tool.execute(v.call.arguments, {
      cwd: process.cwd(),
      signal: signal ?? AbortSignal.timeout(120_000),
    })

    const truncated = v.call.name === "bash"
      ? truncateTail(result.content)
      : truncateHead(result.content)

    results.push({
      role: "tool_result",
      toolCallId: v.call.id,
      toolName: v.call.name,
      content: truncated.content,
      isError: result.isError,
    })
    onEvent?.({ type: "tool_result", name: v.call.name, result })
  }

  return results
}
```

---

## Layer 4: Agents & Subagents

### Agent Configuration

```typescript
interface AgentConfig {
  name: string
  description: string
  systemPrompt: string
  tools: string[]        // Tool names this agent can use
  maxTurns: number
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
    description: "Planning and analysis agent. Reads code, reasons about architecture, produces plans. Cannot modify files or run commands.",
    systemPrompt: `You are a planning assistant. Analyze code, reason about architecture, and produce detailed plans.
You CANNOT modify files or run commands — only read and search.
Be thorough but concise. Structure your output with clear headings.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 20,
  },

  explore: {
    name: "explore",
    description: "Fast codebase exploration agent. Searches files, reads code, answers questions about the codebase. Cannot modify anything.",
    systemPrompt: `You are a codebase exploration assistant. Quickly find files, search patterns, and read code to answer questions.
Be concise — report findings, not process.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 10,
  },
}
```

**Note:** Subagents (plan, explore) do NOT get the `spawn_agent` tool — no recursive spawning.

### `spawn_agent` Tool Implementation

```typescript
const spawnAgentTool: ToolDefinition = {
  name: "spawn_agent",
  description: `Spawn a subagent for a focused subtask. Available agents:
- "plan": Planning and analysis, reads code but cannot modify. Use for architecture decisions, code review, and design.
- "explore": Fast codebase exploration. Use when you need to find files, search patterns, or understand code structure.`,
  parameters: {
    type: "object",
    properties: {
      agent: { type: "string", enum: ["plan", "explore"] },
      prompt: { type: "string", description: "Task description for the subagent" },
    },
    required: ["agent", "prompt"],
  },
  async execute(params, context) {
    const agentConfig = AGENTS[params.agent]
    if (!agentConfig) return { content: `Unknown agent: ${params.agent}`, isError: true }

    const tools = agentConfig.tools.map(getTool).filter(Boolean)

    const result = await agentLoop({
      agent: agentConfig,
      provider: currentProvider,     // Inherit from parent
      model: currentModel,           // Inherit from parent
      messages: [{ role: "user", content: params.prompt }],  // Fresh history
      systemPrompt: buildSystemPrompt(agentConfig),           // Includes AGENTS.md
      tools,
      maxTurns: agentConfig.maxTurns,
      signal: context.signal,
    })

    // Return only the final text response (opaque to parent)
    const lastAssistant = result.messages.findLast((m) => m.role === "assistant")
    const text = extractText(lastAssistant)

    // Show subagent cost to user (not in the tool result — just for display)
    const cost = calculateCost(currentModel, result.usage)
    onEvent?.({
      type: "tool_result",
      name: "spawn_agent",
      result: {
        content: `${agentConfig.name} agent: ${result.turns} turns, ${result.usage.inputTokens + result.usage.outputTokens} tokens, $${cost.toFixed(4)}`,
      },
    })

    return { content: text || "(subagent produced no response)" }
  },
}
```

### System Prompt Assembly

Built **once per session** and reused for every LLM call (prompt caching).
No dynamic content (no timestamps, no turn counts).

```typescript
function buildSystemPrompt(agent: AgentConfig, cwd: string): string {
  const parts: string[] = [agent.systemPrompt]

  // Add AGENTS.md if present
  const agentsMd = loadAgentsMd(cwd)
  if (agentsMd) {
    parts.push(`## Project Rules (AGENTS.md)\n\n${agentsMd}`)
  }

  // Add available skills summary (only for build agent)
  if (agent.name === "build") {
    const skills = discoverSkills(cwd)
    if (skills.length > 0) {
      parts.push(`## Available Skills\n\nThe user can invoke skills with /skill:<name>. Available:\n${skills.map((s) => `- /skill:${s.name} — ${s.description}`).join("\n")}`)
    }
  }

  // Security reminders
  parts.push(`## Security Rules
- Never read or write files outside the project directory
- Never write secrets or API keys to files
- Always confirm before running destructive commands (rm -rf, git reset, etc.)`)

  return parts.join("\n\n")
}
```

---

## Layer 5: Security

### Path Validation

All file operations pass through path validation:

```typescript
function validatePath(filePath: string, cwd: string): { valid: boolean; resolved: string; reason?: string } {
  const resolved = resolve(cwd, filePath)

  // Must be within project directory (cwd or below)
  if (!resolved.startsWith(cwd)) {
    return { valid: false, resolved, reason: "Path outside project directory" }
  }

  // Block sensitive files
  const basename = path.basename(resolved)
  const BLOCKED_FILES = [".env", ".env.local", ".env.production", "credentials.json", "secrets.json"]
  if (BLOCKED_FILES.includes(basename)) {
    return { valid: false, resolved, reason: `Access to ${basename} is blocked for security` }
  }

  // Block sensitive directories
  const BLOCKED_DIRS = [".git/objects", ".git/refs", "node_modules/.cache"]
  if (BLOCKED_DIRS.some((d) => resolved.includes(d))) {
    return { valid: false, resolved, reason: "Access to this directory is blocked" }
  }

  return { valid: true, resolved }
}
```

### Dangerous Command Detection

For the `bash` tool:

```typescript
interface CommandCheck {
  allowed: boolean
  requiresConfirmation: boolean
  reason?: string
}

const BLOCKED_PATTERNS = [
  /\brm\s+(-[rf]+\s+)?\/(?!\w)/,       // rm -rf / (root deletion)
  /\bmkfs\b/,                            // Format filesystem
  /\bdd\s+.*of=\/dev/,                   // Write to device
  />\s*\/dev\/sd/,                        // Redirect to device
  /\bcurl\b.*\|\s*\bsh\b/,              // Pipe curl to shell
]

const CONFIRM_PATTERNS = [
  { pattern: /\brm\s+-[rf]/, reason: "Recursive/forced file deletion" },
  { pattern: /\bgit\s+reset\s+--hard/, reason: "Hard git reset (destructive)" },
  { pattern: /\bgit\s+push\s+.*--force/, reason: "Force push (destructive)" },
  { pattern: /\bgit\s+clean\s+-[fd]/, reason: "Git clean (removes untracked files)" },
  { pattern: /\bdrop\s+table\b/i, reason: "SQL table drop" },
  { pattern: /\bdrop\s+database\b/i, reason: "SQL database drop" },
  { pattern: /\bchmod\s+777\b/, reason: "Overly permissive file permissions" },
  { pattern: /\bsudo\b/, reason: "Elevated privileges" },
]

function checkCommand(command: string): CommandCheck {
  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, requiresConfirmation: false, reason: "Command blocked for safety" }
    }
  }

  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: true, requiresConfirmation: true, reason }
    }
  }

  return { allowed: true, requiresConfirmation: false }
}
```

### Secrets Detection

Prevent the LLM from writing secrets to files:

```typescript
const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}/i,
  /sk-[a-zA-Z0-9]{20,}/,           // OpenAI keys
  /sk-ant-[a-zA-Z0-9\-]{20,}/,     // Anthropic keys
  /ghp_[a-zA-Z0-9]{36,}/,          // GitHub tokens
  /AKIA[A-Z0-9]{16}/,              // AWS access keys
]

function containsSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(content))
}
```

Used in the `write` and `edit` tools — if detected, return a warning as tool result
instead of writing.

### Permission Prompt Flow

When tool calls require confirmation, prompts are batched upfront before any execution.

```typescript
interface PermissionRequest {
  tool: string
  description: string       // Human-readable description of what will happen
  reason: string            // Why confirmation is needed
}

// Returns: "allow" | "deny" | "allow_session" (remember for this session)
type PermissionResponse = "allow" | "deny" | "allow_session"

// Session-scoped memory for "allow_session" responses
const sessionPermissions = new Map<string, boolean>()

// Batch prompt: shows all dangerous operations at once, user approves/denies each
async function promptPermissions(requests: PermissionRequest[]): Promise<PermissionResponse[]> {
  // Check session-scoped memory first
  // Then prompt user for remaining
  // "allow_session" remembers the pattern for this session
}
```

If user denies a tool call, tools 1, 3, 4 (safe ones) still execute.
Tool 2 (denied) gets an error result: "User denied permission." The LLM adapts.

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

**First-run hint:** On first session creation, print once:
```
Session saved to .tokenius/sessions/abc123.jsonl
Tip: Add .tokenius/sessions/ to your .gitignore
```

### Session Header (First Line)

```json
{
  "type": "session",
  "id": "abc123",
  "timestamp": "2026-04-13T10:00:00Z",
  "cwd": "/Users/nikolas.b/Dev/myproject",
  "model": "claude-sonnet-4-20250514",
  "title": "Fix auth bug"
}
```

### Entry Types

```typescript
type SessionEntry = SessionHeader | MessageEntry

interface SessionHeader {
  type: "session"
  id: string
  timestamp: string
  cwd: string
  model: string
  title?: string
}

interface MessageEntry {
  type: "message"
  id: string
  timestamp: string
  message: Message
}
```

### Session Manager

```typescript
interface SessionManager {
  create(cwd: string, model: string): Session
  list(cwd: string): SessionSummary[]          // Filtered by cwd
  load(id: string): Session
  append(sessionId: string, entry: SessionEntry): void
}

interface Session {
  id: string
  header: SessionHeader
  messages: Message[]
}

interface SessionSummary {
  id: string
  title: string
  cwd: string
  timestamp: string
  messageCount: number
}
```

### Session Title — Auto-generated

After the first LLM response, generate a short title from the first user message:

```typescript
async function generateSessionTitle(firstUserMessage: string, provider: Provider, model: string): Promise<string> {
  // Quick LLM call: "Summarize this request in 3-5 words for a session title"
  // e.g., "Fix auth bug" or "Add pagination to API"
}
```

### Writing Entries

```typescript
function appendEntry(sessionPath: string, entry: SessionEntry): void {
  const line = JSON.stringify(entry) + "\n"
  Bun.write(sessionPath, line, { append: true })
}
```

### Loading a Session

```typescript
function loadSession(sessionPath: string): Session {
  const content = Bun.file(sessionPath).text()
  const lines = content.split("\n").filter(Boolean)
  const entries = lines.map((l) => JSON.parse(l) as SessionEntry)

  const header = entries[0] as SessionHeader
  const messages: Message[] = []

  for (const entry of entries.slice(1)) {
    if (entry.type === "message") {
      messages.push(entry.message)
    }
  }

  return { id: header.id, header, messages }
}
```

### Listing Sessions

```typescript
function listSessions(cwd: string): SessionSummary[] {
  const sessionsDir = join(cwd, ".tokenius", "sessions")
  if (!existsSync(sessionsDir)) return []

  const files = readdirSync(sessionsDir).filter((f) => f.endsWith(".jsonl"))
  return files
    .map((f) => {
      const firstLine = readFirstLine(join(sessionsDir, f))
      const header = JSON.parse(firstLine) as SessionHeader
      const lineCount = countLines(join(sessionsDir, f))
      return {
        id: header.id,
        title: header.title ?? "(untitled)",
        cwd: header.cwd,
        timestamp: header.timestamp,
        messageCount: lineCount - 1,  // Subtract header
      }
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))  // Most recent first
}
```

---

## Layer 7: Skills

### Skill Definition

```typescript
interface Skill {
  name: string                // kebab-case, 1-64 chars
  description: string
  content: string             // Full markdown content (body after frontmatter)
  path: string                // Source file path
}
```

### Discovery

Skills are discovered from `.tokenius/skills/` in the project directory.

```typescript
function discoverSkills(cwd: string): Skill[] {
  const skills: Skill[] = []
  const skillDir = join(cwd, ".tokenius", "skills")

  if (!existsSync(skillDir)) return skills

  for (const entry of readdirSync(skillDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const skillMd = join(skillDir, entry.name, "SKILL.md")
    if (existsSync(skillMd)) {
      skills.push(parseSkill(skillMd))
    }
  }

  return skills
}
```

### SKILL.md Parsing

```typescript
function parseSkill(path: string): Skill {
  const content = readFileSync(path, "utf-8")
  const { frontmatter, body } = parseFrontmatter(content)

  return {
    name: frontmatter.name ?? basename(dirname(path)),
    description: frontmatter.description ?? "",
    content: body,
    path,
  }
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { frontmatter: {}, body: content }

  const frontmatter: Record<string, string> = {}
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":")
    if (key && rest.length) {
      frontmatter[key.trim()] = rest.join(":").trim().replace(/^["']|["']$/g, "")
    }
  }

  return { frontmatter, body: match[2] }
}
```

### Skill Invocation

User types `/skill:code-review review this file`. The skill content is prepended
to the user message (simplest approach):

```typescript
function invokeSkill(skillName: string, userPrompt: string, cwd: string): string {
  const skill = discoverSkills(cwd).find((s) => s.name === skillName)
  if (!skill) throw new Error(`Unknown skill: ${skillName}`)

  return `${skill.content}\n\n---\n\nUser request: ${userPrompt}`
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

```typescript
interface TokeniusConfig {
  // LLM
  provider: ProviderId               // Default: "anthropic"
  model: string                      // Default: "claude-sonnet-4-20250514"

  // Agent
  maxTurns?: number                  // Override default per-agent maxTurns

  // Security
  permissions?: {
    bash?: PermissionRule[]          // Glob patterns for allow/deny
    blockedPaths?: string[]          // Additional blocked file paths
  }
}

interface PermissionRule {
  pattern: string                    // Glob pattern (e.g., "git *")
  action: "allow" | "deny" | "ask"
}

const DEFAULT_CONFIG: TokeniusConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
}
```

### Config Loading — Fail Fast

```typescript
function loadConfig(cwd: string): TokeniusConfig {
  const configPath = join(cwd, "tokenius.json")
  if (!existsSync(configPath)) return DEFAULT_CONFIG

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"))
  } catch (error) {
    throw new Error(`Invalid JSON in tokenius.json: ${(error as Error).message}`)
  }

  const config = { ...DEFAULT_CONFIG, ...(raw as Partial<TokeniusConfig>) }

  // Validate provider
  if (!["anthropic", "openai"].includes(config.provider)) {
    throw new Error(`Invalid provider "${config.provider}" in tokenius.json. Must be "anthropic" or "openai".`)
  }

  // Validate model
  if (!MODELS[config.model]) {
    const known = Object.keys(MODELS).join(", ")
    throw new Error(`Unknown model "${config.model}" in tokenius.json. Known models: ${known}`)
  }

  return config
}
```

### API Key Resolution — Env Vars Only

```typescript
function resolveApiKey(provider: ProviderId): string {
  const envKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
  const value = process.env[envKey]  // Bun auto-loads .env
  if (!value) {
    throw new Error(`Missing ${envKey}. Set it in your environment or .env file.`)
  }
  return value
}
```

### AGENTS.md Loading

Simple: load from project root if present.

```typescript
function loadAgentsMd(cwd: string): string | null {
  const agentsPath = join(cwd, "AGENTS.md")
  if (existsSync(agentsPath)) {
    return readFileSync(agentsPath, "utf-8")
  }
  return null
}
```

---

## Layer 9: CLI & TUI

### Phase 1: Simple CLI (Readline)

Start here. No dependencies beyond what Bun provides + chalk for colors.

```typescript
import { createInterface } from "readline"

async function main() {
  // Fail fast on bad config
  const config = loadConfig(process.cwd())
  const apiKey = resolveApiKey(config.provider)
  const provider = createProvider(config.provider, { apiKey })

  // Build system prompt ONCE (static for prompt caching)
  const systemPrompt = buildSystemPrompt(AGENTS.build, process.cwd())

  // Always start a new session
  const session = sessionManager.create(process.cwd(), config.model)

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  console.log("Tokenius — type /help for commands, /quit to exit\n")

  // Abort controller for Ctrl+C handling
  let abortController = new AbortController()

  // First Ctrl+C aborts the loop, second kills the process
  let lastCtrlC = 0
  process.on("SIGINT", () => {
    const now = Date.now()
    if (now - lastCtrlC < 1000) process.exit(0)  // Double Ctrl+C = kill
    lastCtrlC = now
    abortController.abort()
    abortController = new AbortController()  // Reset for next prompt
  })

  while (true) {
    const input = await question(rl, "> ")
    if (!input.trim()) continue

    // Handle slash commands
    if (input.startsWith("/")) {
      await handleCommand(input, session)
      continue
    }

    // Handle skill invocation: /skill:name rest of prompt
    let userMessage = input
    if (input.startsWith("/skill:")) {
      const skillName = input.slice(7).split(" ")[0]
      const userPrompt = input.slice(7 + skillName.length).trim()
      userMessage = invokeSkill(skillName, userPrompt, process.cwd())
    }

    // Add user message
    session.messages.push({ role: "user", content: userMessage })

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
    })

    session.messages = result.messages
    persistSession(session)
    printUsage(result.usage, config.model)

    // Generate title after first exchange
    if (!session.header.title) {
      session.header.title = await generateSessionTitle(input, provider, config.model)
      updateSessionHeader(session)
    }
  }
}
```

### Slash Commands

```typescript
const COMMANDS: Record<string, (args: string, session: Session) => Promise<void>> = {
  "/help":     async () => { printHelp() },
  "/quit":     async () => { process.exit(0) },
  "/sessions": async () => { listSessions(process.cwd()) },
  "/load":     async (id) => { /* load session by id, replace current */ },
  "/cost":     async (_, session) => { printSessionCost(session) },
  "/clear":    async (_, session) => { session.messages = [] },
  "/model":    async (model) => { /* validate and switch model */ },
  "/skills":   async () => { listAvailableSkills(process.cwd()) },
}
```

### Streaming Output Rendering

```typescript
import chalk from "chalk"

function renderEvent(event: AgentEvent): void {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text)
      break
    case "thinking_delta":
      process.stdout.write(chalk.dim(event.thinking))
      break
    case "tool_call_start":
      console.log(chalk.cyan(`\n> ${event.name}`))
      break
    case "tool_result":
      if (event.result.isError) {
        console.log(chalk.red(`  x Error: ${event.result.content.slice(0, 200)}`))
      } else {
        console.log(chalk.green(`  Done (${event.result.content.length} chars)`))
      }
      break
    case "turn_end":
      // Optionally show per-turn token count
      break
    case "context_limit_reached":
      console.log(chalk.yellow("\nSession context full. Start a new session or use /clear."))
      break
  }
}

function printUsage(usage: TokenUsage, model: string): void {
  const cost = calculateCost(model, usage)
  console.log(chalk.dim(`\n${usage.inputTokens + usage.outputTokens} tokens ($${cost.toFixed(4)})`))
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

## Implementation Order

Build bottom-up. Each sprint produces a working, testable increment.

### Sprint 1: Foundation (days 1-3)
1. **Types** — define all core types in `types.ts`
2. **Model metadata** — hardcoded map with pricing + context windows
3. **Provider abstraction** — `Provider` interface + Anthropic implementation
4. **Retry logic** — `streamWithRetry` with exponential backoff
5. **Smoke test** — hardcoded prompt, stream response to stdout

### Sprint 2: Tools (days 4-6)
6. **Tool system** — registry, schema validation, truncation
7. **Implement `read`, `grep`, `glob`** — read-only tools first
8. **Implement `bash`** — with timeout, process kill, spinner (no streaming)
9. **Implement `write`, `edit`** — with `replace_all` option on edit

### Sprint 3: Agent Loop (days 7-9)
10. **Agent loop** — the core while loop with context limit check
11. **Sequential tool execution** — validate-then-execute
12. **Agent configs** — build, plan, explore definitions
13. **`spawn_agent` tool** — subagent invocation with cost display

### Sprint 4: Security (day 10)
14. **Path validation** — in all file tools
15. **Command detection** — blocked + confirmation patterns in bash
16. **Secrets detection** — in write/edit tools
17. **Permission prompts** — batch upfront, session-scoped memory

### Sprint 5: Persistence (days 11-12)
18. **Session JSONL** — create, append, load
19. **Session listing** — list by cwd, most recent first
20. **Session resume** — `/load` command
21. **Auto-title** — LLM-generated after first exchange

### Sprint 6: Config & Skills (days 13-14)
22. **Config loading** — `tokenius.json` with fail-fast validation
23. **API key resolution** — env vars + .env only
24. **AGENTS.md** — loading + injection into system prompt
25. **Skills** — discovery, parsing, `/skill:name` invocation

### Sprint 7: CLI (days 15-16)
26. **Readline CLI** — input loop, command parsing, Ctrl+C handling
27. **Streaming renderer** — chalk-based output for all AgentEvents
28. **Slash commands** — /help, /sessions, /load, /skill:*, /cost, /clear, /model, /skills
29. **Context limit UX** — clear message when session is full

### Sprint 8: Polish (days 17-18)
30. **OpenAI provider** — second provider implementation
31. **Error handling** — network failures, empty responses, abort
32. **Edge cases** — binary file detection, empty directories, missing rg fallback
33. **First-run experience** — .gitignore hint, missing API key message

### Sprint 9: TUI (later)
34. **TUI framework** — Ink or custom
35. **Rich rendering** — syntax highlighting, spinners, split panes, bash streaming

---

## Directory Structure

```
tokenius/
  src/
    index.ts                     # Entry point — bootstrap and start CLI
    types.ts                     # All shared type definitions

    providers/
      types.ts                   # Provider, StreamEvent, LLMContext
      registry.ts                # Provider registry
      anthropic.ts               # Anthropic SDK → StreamEvent
      openai.ts                  # OpenAI SDK → StreamEvent (also covers xAI, GLM, etc.)
      models.ts                  # Hardcoded model metadata (pricing, context, capabilities)
      retry.ts                   # streamWithRetry, exponential backoff
      cost.ts                    # calculateCost, addUsage

    tools/
      types.ts                   # ToolDefinition, ToolResult, ToolContext
      registry.ts                # Tool registry + getToolSchemas (sorted for caching)
      truncation.ts              # truncateHead, truncateTail
      validation.ts              # JSON Schema arg validation
      read.ts
      write.ts
      edit.ts                    # Includes replace_all support
      bash.ts                    # Spinner, timeout, process kill
      grep.ts
      glob.ts
      spawn-agent.ts

    agent/
      loop.ts                    # agentLoop() — the core algorithm
      stream.ts                  # streamResponse() — accumulate stream
      execute.ts                 # validateToolCalls + executeToolsSequential
      agents.ts                  # Built-in agent configs (build, plan, explore)
      system-prompt.ts           # buildSystemPrompt() — static per session
      context-tracker.ts         # Token tracking from real provider usage

    security/
      path-validation.ts         # validatePath()
      command-detection.ts       # checkCommand()
      secrets-detection.ts       # containsSecrets()
      permissions.ts             # Batch permission prompts, session memory

    session/
      types.ts                   # SessionEntry, SessionHeader
      manager.ts                 # create, list, load, append
      title.ts                   # Auto-generate session title via LLM

    skills/
      discovery.ts               # discoverSkills()
      parser.ts                  # parseFrontmatter, parseSkill

    config/
      loader.ts                  # loadConfig() — fail fast validation
      api-keys.ts                # resolveApiKey() — env vars only
      agents-md.ts               # loadAgentsMd()

    cli/
      index.ts                   # Main readline loop, Ctrl+C handling
      commands.ts                # Slash command handlers
      renderer.ts                # Streaming output rendering (chalk)

  .tokenius/
    skills/                      # Project skills (committed)
    sessions/                    # Session files (gitignored)
```
