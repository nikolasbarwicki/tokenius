# Tokenius — Technical Architecture

A lightweight, well-designed coding agent harness. Single-process TypeScript + Bun.

---

## Table of Contents

1. [Design Principles](#design-principles)
2. [System Architecture](#system-architecture)
3. [Layer 1: LLM Provider Abstraction](#layer-1-llm-provider-abstraction)
4. [Layer 2: Tool System](#layer-2-tool-system)
5. [Layer 3: Agent Loop](#layer-3-agent-loop)
6. [Layer 4: Agents & Subagents](#layer-4-agents--subagents)
7. [Layer 5: Security](#layer-5-security)
8. [Layer 6: Session Persistence & Compaction](#layer-6-session-persistence--compaction)
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
│    Session Persistence & Compaction     │  Layer 6
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
    → Build LLM context (system prompt + AGENTS.md + messages + tool schemas)
    → Stream LLM response
    → Extract tool calls from response
    → Security check each tool call
    → Execute tools (parallel by default)
    → Append tool results to messages
    → Loop back to LLM if tool calls were made
  → Agent loop ends (no more tool calls)
  → Persist messages to session JSONL
  → Display final response to user
```

---

## Layer 1: LLM Provider Abstraction

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
          messages: convertMessages(context.messages), // Map to Anthropic format
          tools: convertTools(context.tools), // Map to Anthropic format
          max_tokens: context.maxTokens,
        },
        { signal },
      );

      for await (const event of stream) {
        yield mapToStreamEvent(event); // Normalize to common StreamEvent
      }
    },
  };
}
```

```typescript
// src/providers/openai.ts
import OpenAI from "openai";

export function createOpenAIProvider(config: ProviderConfig): Provider {
  const client = new OpenAI({ apiKey: config.apiKey });

  return {
    id: "openai",
    async *stream(model, context, signal) {
      const stream = await client.chat.completions.create(
        {
          model,
          messages: convertMessages(context.messages), // Map to OpenAI format
          tools: convertTools(context.tools), // Map to OpenAI format
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

Tool arguments arrive incrementally during streaming. Accumulate the string and
parse with fallback:

```typescript
function parsePartialJson<T>(incomplete: string): T {
  try {
    return JSON.parse(incomplete);
  } catch {
    // Attempt to close open braces/brackets for partial parsing
    return partialParse(incomplete);
  }
}
```

### Token Cost Calculation

```typescript
interface ModelPricing {
  input: number; // Cost per 1M tokens
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  "gpt-5.4": { input: 2.5, output: 15, cacheRead: 1.25 },
  // ...
};

function calculateCost(model: string, usage: TokenUsage): number {
  const pricing = MODEL_PRICING[model];
  if (!pricing) return 0;
  return (
    (usage.inputTokens * pricing.input) / 1_000_000 +
    (usage.outputTokens * pricing.output) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? 0)) / 1_000_000 +
    ((usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? 0)) / 1_000_000
  );
}
```

### Context Overflow Detection

Detect when the provider rejects due to context length:

```typescript
const OVERFLOW_PATTERNS = [
  /prompt is too long/i,
  /context_length_exceeded/i,
  /max_tokens/i,
  /exceeds.*maximum.*context/i,
];

function isContextOverflow(error: Error): boolean {
  return OVERFLOW_PATTERNS.some((p) => p.test(error.message));
}
```

When detected, trigger compaction (Layer 6) and retry.

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

interface ToolContext {
  cwd: string; // Working directory
  signal: AbortSignal; // Cancellation
  onProgress?: (text: string) => void; // Streaming progress for long operations
}

interface ToolResult {
  content: string;
  isError?: boolean;
}

type JsonSchema = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
};
```

### Tool Registry

```typescript
const tools = new Map<string, ToolDefinition>();

function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool);
}

function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

function getToolSchemas(): ToolSchema[] {
  return [...tools.values()].map((t) => ({
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
  // Returns: file content with line numbers
  // Truncation: truncateHead
  // Security: path validation (Layer 5)
  // Special: detect binary files, detect images (return description)
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
  // Security: path validation, secrets detection (don't write .env)
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
  },
  // Fails if old_string not found or matches multiple locations
  // Returns: confirmation with surrounding context
  // Security: path validation
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
  // Output: combined stdout+stderr
  // Truncation: truncateTail (errors at bottom)
  // Progress: stream partial output via onProgress callback
  // Cleanup: kill process tree on timeout/abort
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
  // Returns: the subagent's final text response
  // Subagent gets: parent's AGENTS.md + system context, fresh message history
  // Does NOT store subagent messages in parent session
}
```

### File Mutation Queue

Prevent race conditions when parallel tool calls write to the same file:

```typescript
const fileQueues = new Map<string, Promise<void>>();

async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const resolved = resolve(filePath); // Canonical path
  const previous = fileQueues.get(resolved) ?? Promise.resolve();
  const current = previous.then(fn);
  fileQueues.set(
    resolved,
    current.then(() => {}).catch(() => {}),
  );
  return current;
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
  messages: Message[]; // Conversation history
  systemPrompt: string; // Assembled system prompt
  tools: ToolDefinition[]; // Available tools for this agent
  maxTurns: number; // Safety limit
  signal?: AbortSignal; // Cancellation
  onEvent?: (event: AgentEvent) => void; // Progress callback for UI
}

interface AgentLoopResult {
  messages: Message[]; // Updated message history
  usage: TokenUsage; // Accumulated token usage
  turns: number; // How many LLM calls were made
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
  | { type: "error"; error: Error };
```

### The Loop (Pseudocode)

```typescript
async function agentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { agent, provider, model, messages, systemPrompt, tools, maxTurns, signal, onEvent } =
    config;
  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;

  while (turn < maxTurns) {
    turn++;
    onEvent?.({ type: "turn_start", turn });

    // 1. Build LLM context
    const context: LLMContext = {
      systemPrompt,
      messages,
      tools: getToolSchemas(tools),
      maxTokens: 16_384,
    };

    // 2. Stream LLM response
    const assistantMessage = await streamResponse(provider, model, context, signal, onEvent);
    messages.push(assistantMessage);
    totalUsage = addUsage(totalUsage, assistantMessage.usage);

    // 3. Check stop condition
    if (assistantMessage.stopReason === "error") {
      onEvent?.({ type: "error", error: new Error("LLM error") });
      break;
    }

    const toolCalls = extractToolCalls(assistantMessage);
    if (toolCalls.length === 0) break; // Done — no more tool calls

    // 4. Execute tools (parallel)
    const toolResults = await executeTools(toolCalls, tools, signal, onEvent);
    messages.push(...toolResults);
  }

  return { messages, usage: totalUsage, turns: turn };
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
  const content: AssistantContent[] = [];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: string = "stop";

  // Accumulators for streaming tool call arguments
  let currentToolArgs = "";

  for await (const event of provider.stream(model, context, signal)) {
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
        currentToolArgs = "";
        onEvent?.({ type: "tool_call_start", name: event.name, id: event.id });
        break;

      case "tool_call_delta":
        currentToolArgs += event.arguments;
        onEvent?.({ type: "tool_call_args", name: "", partialArgs: currentToolArgs });
        break;

      case "tool_call_end":
        const lastToolCall = content.at(-1) as ToolCallBlock;
        lastToolCall.arguments = parsePartialJson(currentToolArgs);
        break;

      case "message_end":
        usage = event.usage;
        stopReason = event.stopReason;
        break;

      case "error":
        throw event.error;
    }
  }

  return { role: "assistant", content, usage, stopReason };
}
```

### Parallel Tool Execution (3-Phase)

```typescript
async function executeTools(
  toolCalls: ToolCallBlock[],
  tools: ToolDefinition[],
  signal: AbortSignal | undefined,
  onEvent: ((event: AgentEvent) => void) | undefined,
): Promise<ToolResultMessage[]> {
  // Phase 1: VALIDATE (sequential)
  const prepared: Array<{ call: ToolCallBlock; tool: ToolDefinition; errors?: string[] }> = [];
  for (const call of toolCalls) {
    const tool = getTool(call.name);
    if (!tool) {
      prepared.push({ call, tool: null!, errors: [`Unknown tool: ${call.name}`] });
      continue;
    }
    const validation = validateArgs(tool.parameters, call.arguments);
    if (!validation.valid) {
      prepared.push({ call, tool, errors: validation.errors });
      continue;
    }
    // Security check (Layer 5)
    const security = await checkToolPermission(call);
    if (security.blocked) {
      prepared.push({ call, tool, errors: [security.reason] });
      continue;
    }
    prepared.push({ call, tool });
  }

  // Phase 2: EXECUTE (concurrent)
  const executions = prepared.map((p) => {
    if (p.errors) {
      return Promise.resolve(errorResult(p.call, p.errors.join("\n")));
    }
    onEvent?.({ type: "tool_call_start", name: p.call.name, id: p.call.id });
    return p.tool.execute(p.call.arguments, { cwd: process.cwd(), signal });
  });

  // Phase 3: COLLECT (sequential — maintains order)
  const results: ToolResultMessage[] = [];
  for (let i = 0; i < executions.length; i++) {
    const result = await executions[i];
    const truncated = shouldTruncateTail(prepared[i].call.name)
      ? truncateTail(result.content)
      : truncateHead(result.content);

    results.push({
      role: "tool_result",
      toolCallId: prepared[i].call.id,
      toolName: prepared[i].call.name,
      content: truncated.content,
      isError: result.isError,
    });
    onEvent?.({ type: "tool_result", name: prepared[i].call.name, result });
  }

  return results;
}

function shouldTruncateTail(toolName: string): boolean {
  return toolName === "bash"; // Bash errors are at the bottom
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
    const agentConfig = AGENTS[params.agent];
    if (!agentConfig) return { content: `Unknown agent: ${params.agent}`, isError: true };

    const tools = agentConfig.tools.map(getTool).filter(Boolean);

    const result = await agentLoop({
      agent: agentConfig,
      provider: currentProvider, // Inherit from parent
      model: currentModel, // Inherit from parent
      messages: [{ role: "user", content: params.prompt }], // Fresh history
      systemPrompt: buildSystemPrompt(agentConfig), // Includes AGENTS.md
      tools,
      maxTurns: agentConfig.maxTurns,
      signal: context.signal,
    });

    // Return only the final text response (opaque to parent)
    const lastAssistant = result.messages.findLast((m) => m.role === "assistant");
    const text = extractText(lastAssistant);
    return { content: text || "(subagent produced no response)" };
  },
};
```

### System Prompt Assembly

```typescript
function buildSystemPrompt(agent: AgentConfig): string {
  const parts: string[] = [agent.systemPrompt];

  // Add AGENTS.md if present
  const agentsMd = loadAgentsMd();
  if (agentsMd) {
    parts.push(`\n## Project Rules (AGENTS.md)\n\n${agentsMd}`);
  }

  // Add available skills summary
  const skills = discoverSkills();
  if (skills.length > 0) {
    parts.push(
      `\n## Available Skills\n\n${skills.map((s) => `- /skill:${s.name} — ${s.description}`).join("\n")}`,
    );
  }

  // Add security reminders
  parts.push(`\n## Security Rules
- Never read or write files outside the project directory
- Never write secrets or API keys to files
- Always confirm before running destructive commands (rm -rf, git reset, etc.)`);

  return parts.join("\n\n");
}
```

---

## Layer 5: Security

### Path Validation

All file operations pass through path validation:

```typescript
function validatePath(
  filePath: string,
  cwd: string,
): { valid: boolean; resolved: string; reason?: string } {
  const resolved = resolve(cwd, filePath);

  // Must be within project directory (cwd or below)
  if (!resolved.startsWith(cwd)) {
    return { valid: false, resolved, reason: "Path outside project directory" };
  }

  // Block sensitive files
  const basename = path.basename(resolved);
  const BLOCKED_FILES = [
    ".env",
    ".env.local",
    ".env.production",
    "credentials.json",
    "secrets.json",
  ];
  if (BLOCKED_FILES.includes(basename)) {
    return { valid: false, resolved, reason: `Access to ${basename} is blocked for security` };
  }

  // Block sensitive directories
  const BLOCKED_DIRS = [".git/objects", ".git/refs", "node_modules/.cache"];
  if (BLOCKED_DIRS.some((d) => resolved.includes(d))) {
    return { valid: false, resolved, reason: "Access to this directory is blocked" };
  }

  return { valid: true, resolved };
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

const BLOCKED_PATTERNS = [
  /\brm\s+(-[rf]+\s+)?\/(?!\w)/, // rm -rf / (root deletion)
  /\bmkfs\b/, // Format filesystem
  /\bdd\s+.*of=\/dev/, // Write to device
  />\s*\/dev\/sd/, // Redirect to device
  /\bcurl\b.*\|\s*\bsh\b/, // Pipe curl to shell
];

const CONFIRM_PATTERNS = [
  { pattern: /\brm\s+-[rf]/, reason: "Recursive/forced file deletion" },
  { pattern: /\bgit\s+reset\s+--hard/, reason: "Hard git reset (destructive)" },
  { pattern: /\bgit\s+push\s+.*--force/, reason: "Force push (destructive)" },
  { pattern: /\bgit\s+clean\s+-[fd]/, reason: "Git clean (removes untracked files)" },
  { pattern: /\bdrop\s+table\b/i, reason: "SQL table drop" },
  { pattern: /\bdrop\s+database\b/i, reason: "SQL database drop" },
  { pattern: /\bchmod\s+777\b/, reason: "Overly permissive file permissions" },
  { pattern: /\bsudo\b/, reason: "Elevated privileges" },
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

Prevent the LLM from writing secrets to files:

```typescript
const SECRET_PATTERNS = [
  /(?:api[_-]?key|secret|token|password)\s*[:=]\s*["']?[a-zA-Z0-9_\-]{20,}/i,
  /sk-[a-zA-Z0-9]{20,}/, // OpenAI keys
  /sk-ant-[a-zA-Z0-9\-]{20,}/, // Anthropic keys
  /ghp_[a-zA-Z0-9]{36,}/, // GitHub tokens
  /AKIA[A-Z0-9]{16}/, // AWS access keys
];

function containsSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(content));
}
```

Used in the `write` and `edit` tools — if detected, return a warning as tool result
instead of writing.

### Permission Prompt Flow

When a tool call requires confirmation:

```typescript
interface PermissionRequest {
  tool: string;
  description: string; // Human-readable description of what will happen
  reason: string; // Why confirmation is needed
}

// The CLI layer handles prompting the user
// Returns: "allow" | "deny" | "allow_session" (remember for this session)
type PermissionResponse = "allow" | "deny" | "allow_session";

// Session-scoped memory for "allow_session" responses
const sessionPermissions = new Map<string, boolean>();
```

---

## Layer 6: Session Persistence & Compaction

### JSONL Format

One session = one `.jsonl` file. Each line is a JSON entry.

```
~/.tokenius/sessions/
  {session-id}.jsonl
```

### Session Header (First Line)

```json
{
  "type": "session",
  "id": "abc123",
  "timestamp": "2026-04-13T10:00:00Z",
  "cwd": "/Users/nikolas.b/Dev/myproject",
  "title": "Fix auth bug"
}
```

### Entry Types

```typescript
type SessionEntry = SessionHeader | MessageEntry | CompactionEntry;

interface SessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
  title?: string;
}

interface MessageEntry {
  type: "message";
  id: string;
  timestamp: string;
  message: Message; // UserMessage | AssistantMessage | ToolResultMessage
}

interface CompactionEntry {
  type: "compaction";
  id: string;
  timestamp: string;
  summary: string;
  discardedCount: number; // How many messages were summarized
  tokensSaved: number; // Estimated tokens freed
}
```

### Session Manager

```typescript
interface SessionManager {
  create(cwd: string): Session;
  list(): SessionSummary[];
  load(id: string): Session;
  append(id: string, entry: SessionEntry): void;
}

interface Session {
  id: string;
  header: SessionHeader;
  messages: Message[]; // Reconstructed from entries (respecting compactions)
}

interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  timestamp: string;
  messageCount: number;
}
```

### Writing Entries

```typescript
function appendEntry(sessionPath: string, entry: SessionEntry): void {
  const line = JSON.stringify(entry) + "\n";
  Bun.write(sessionPath, line, { append: true }); // Atomic append
}
```

### Reading / Rebuilding Context

```typescript
function loadSession(sessionPath: string): Session {
  const content = Bun.file(sessionPath).text();
  const lines = content.split("\n").filter(Boolean);
  const entries = lines.map((l) => JSON.parse(l));

  const header = entries[0] as SessionHeader;
  const messages: Message[] = [];
  let lastCompaction: CompactionEntry | null = null;

  for (const entry of entries.slice(1)) {
    if (entry.type === "compaction") {
      lastCompaction = entry;
      messages.length = 0; // Clear pre-compaction messages
      // Add summary as a synthetic user message
      messages.push({
        role: "user",
        content: `[Previous conversation summary]\n${entry.summary}`,
      });
    } else if (entry.type === "message") {
      messages.push(entry.message);
    }
  }

  return { id: header.id, header, messages };
}
```

### Context Compaction

Triggered when token count approaches the model's context window.

```typescript
const COMPACTION_CONFIG = {
  reserveTokens: 16_384, // Space for system prompt + response
  keepRecentTokens: 20_000, // Recent context to preserve
};

function shouldCompact(messages: Message[], contextWindow: number): boolean {
  const estimated = estimateTokens(messages);
  return estimated > contextWindow - COMPACTION_CONFIG.reserveTokens;
}
```

### Cut Point Detection

Never cut in the middle of a tool call / tool result pair:

```typescript
function findCutPoint(messages: Message[], keepRecentTokens: number): number {
  let tokenCount = 0;

  // Walk backward from the end
  for (let i = messages.length - 1; i >= 0; i--) {
    tokenCount += estimateTokens(messages[i]);
    if (tokenCount >= keepRecentTokens) {
      // Found rough cut point — adjust to valid boundary
      return adjustCutPoint(messages, i);
    }
  }
  return 0; // Keep everything
}

function adjustCutPoint(messages: Message[], index: number): number {
  // If we're cutting after a tool_call but before its tool_result,
  // move the cut point before the tool_call
  for (let i = index; i >= 0; i--) {
    if (messages[i].role === "tool_result") continue;
    if (messages[i].role === "assistant") {
      const hasToolCalls = extractToolCalls(messages[i]).length > 0;
      if (hasToolCalls && messages[i + 1]?.role === "tool_result") {
        continue; // Keep going back
      }
    }
    return i;
  }
  return 0;
}
```

### Summarization (Using LLM)

```typescript
async function generateCompactionSummary(
  messages: Message[],
  previousSummary?: string,
): Promise<string> {
  const prompt = `Summarize this conversation for continuity. Structure:

## Goal
What the user is trying to accomplish.

## Progress
What has been done so far.

## Key Decisions
Important choices made and why.

## Files Touched
Files read, created, or modified.

## Next Steps
What remains to be done.

${previousSummary ? `\nPrevious summary to incorporate:\n${previousSummary}` : ""}

Conversation to summarize:
${formatMessagesForSummary(messages)}`;

  const result = await provider.stream(model, {
    systemPrompt: "You are a conversation summarizer. Be concise and structured.",
    messages: [{ role: "user", content: prompt }],
    tools: [],
    maxTokens: 2048,
  });

  return extractText(await collectStream(result));
}
```

### Token Estimation

Fast estimation without a tokenizer (good enough for compaction decisions):

```typescript
function estimateTokens(input: string | Message | Message[]): number {
  const text = typeof input === "string" ? input : JSON.stringify(input);
  // ~4 characters per token (rough but consistent)
  return Math.ceil(text.length / 4);
}
```

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

```typescript
function discoverSkills(cwd: string): Skill[] {
  const skills: Skill[] = [];
  const skillDirs = [join(cwd, ".tokenius", "skills"), join(homedir(), ".tokenius", "skills")];

  for (const dir of skillDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const skillMd = join(dir, entry.name, "SKILL.md");
      if (existsSync(skillMd)) {
        skills.push(parseSkill(skillMd));
      }
    }
  }

  return skills;
}
```

### SKILL.md Parsing

```typescript
function parseSkill(path: string): Skill {
  const content = readFileSync(path, "utf-8");
  const { frontmatter, body } = parseFrontmatter(content);

  return {
    name: frontmatter.name ?? basename(dirname(path)),
    description: frontmatter.description ?? "",
    content: body,
    path,
  };
}

function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: content };

  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const [key, ...rest] = line.split(":");
    if (key && rest.length) {
      frontmatter[key.trim()] = rest
        .join(":")
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  }

  return { frontmatter, body: match[2] };
}
```

### Skill Invocation

User types `/skill:react-migration` → the skill's content is prepended to the
user's next message (or used as the message itself):

```typescript
function invokeSkill(skillName: string, userPrompt: string): string {
  const skill = discoverSkills(cwd).find((s) => s.name === skillName);
  if (!skill) throw new Error(`Unknown skill: ${skillName}`);

  return `${skill.content}\n\n---\n\nUser request: ${userPrompt}`;
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

- 🔴 Critical (must fix)
- 🟡 Warning (should fix)
- 🟢 Suggestion (nice to have)
```

---

## Layer 8: Configuration & Project Rules

### `tokenius.json` Schema

```typescript
interface TokeniusConfig {
  // LLM
  provider: ProviderId; // Default: "anthropic"
  model: string; // Default: "claude-sonnet-4-6"
  apiKeys?: {
    anthropic?: string; // Falls back to ANTHROPIC_API_KEY env
    openai?: string; // Falls back to OPENAI_API_KEY env
  };

  // Agent
  maxTurns?: number; // Override default per-agent maxTurns

  // Security
  permissions?: {
    bash?: PermissionRule[]; // Glob patterns for allow/deny
    blockedPaths?: string[]; // Additional blocked file paths
  };

  // Compaction
  compaction?: {
    reserveTokens?: number;
    keepRecentTokens?: number;
  };
}

interface PermissionRule {
  pattern: string; // Glob pattern (e.g., "git *")
  action: "allow" | "deny" | "ask";
}
```

### Config Loading

```typescript
function loadConfig(cwd: string): TokeniusConfig {
  const configPath = join(cwd, "tokenius.json");
  if (!existsSync(configPath)) return DEFAULT_CONFIG;

  const raw = JSON.parse(readFileSync(configPath, "utf-8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

function resolveApiKey(provider: ProviderId, config: TokeniusConfig): string {
  // 1. Config file
  const fromConfig = config.apiKeys?.[provider];
  if (fromConfig) return fromConfig;

  // 2. Environment variable
  const envKey = provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY";
  const fromEnv = process.env[envKey]; // Bun auto-loads .env
  if (fromEnv) return fromEnv;

  throw new Error(`No API key found for ${provider}. Set ${envKey} or add to tokenius.json`);
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

Start here. No dependencies beyond what Bun provides.

```typescript
import { createInterface } from "readline";

async function main() {
  const config = loadConfig(process.cwd());
  const provider = createProvider(config);
  const session = sessionManager.create(process.cwd());

  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log("Tokenius — type /help for commands, /quit to exit\n");

  while (true) {
    const input = await question(rl, "> ");
    if (!input.trim()) continue;

    // Handle commands
    if (input.startsWith("/")) {
      await handleCommand(input, session);
      continue;
    }

    // Run agent loop
    const result = await agentLoop({
      agent: AGENTS.build,
      provider,
      model: config.model,
      messages: session.messages,
      systemPrompt: buildSystemPrompt(AGENTS.build),
      tools: resolveTools(AGENTS.build),
      maxTurns: AGENTS.build.maxTurns,
      onEvent: (event) => renderEvent(event), // Print streaming output
    });

    session.messages = result.messages;
    persistSession(session);
    printUsage(result.usage);
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
    listSessions();
  },
  "/load": async (id) => {
    loadSession(id);
  },
  "/compact": async (_, session) => {
    await compactSession(session);
  },
  "/cost": async (_, session) => {
    printSessionCost(session);
  },
  "/clear": async (_, session) => {
    session.messages = [];
  },
  "/model": async (model) => {
    switchModel(model);
  },
};

// Skill invocation: /skill:name
if (input.startsWith("/skill:")) {
  const skillName = input.slice(7).split(" ")[0];
  const userPrompt = input.slice(7 + skillName.length).trim();
  const enhanced = invokeSkill(skillName, userPrompt);
  // Feed enhanced prompt into agent loop
}
```

### Streaming Output Rendering (Phase 1: Chalk)

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
      console.log(chalk.cyan(`\n⚡ ${event.name}`));
      break;
    case "tool_result":
      if (event.result.isError) {
        console.log(chalk.red(`✗ Error: ${event.result.content.slice(0, 200)}`));
      } else {
        console.log(chalk.green(`✓ Done (${event.result.content.length} chars)`));
      }
      break;
    case "turn_end":
      // Show token usage
      break;
  }
}
```

### Phase 2: TUI (Later)

When ready, replace the readline loop with a proper TUI using Ink (React for terminals)
or a custom approach. The agent loop and event system don't change — only the rendering.

Key TUI features to add:

- Split view (input at bottom, output scrolling above)
- Syntax highlighting for code blocks
- Spinner during LLM calls
- Tool execution progress
- Session info in status bar
- Permission confirmation dialogs

---

## Implementation Order

Build bottom-up. Each layer is independently testable before moving on.

### Sprint 1: Foundation (days 1-3)

1. **Types** — define all core types (`Message`, `StreamEvent`, `ToolResult`, etc.)
2. **Provider abstraction** — `Provider` interface, Anthropic implementation
3. **Simple streaming test** — hardcoded prompt, stream to stdout

### Sprint 2: Tools (days 4-6)

4. **Tool system** — registry, schema validation, truncation
5. **Implement `read`, `grep`, `glob`** — read-only tools first
6. **Implement `bash`** — with streaming output, timeout, process killing
7. **Implement `write`, `edit`** — file mutation tools

### Sprint 3: Agent Loop (days 7-9)

8. **Agent loop** — the core while loop, streaming + tool execution
9. **Parallel tool execution** — 3-phase model
10. **Agent configs** — build, plan, explore definitions
11. **`spawn_agent` tool** — subagent invocation

### Sprint 4: Security (day 10)

12. **Path validation** — in all file tools
13. **Command detection** — in bash tool
14. **Secrets detection** — in write/edit tools
15. **Permission prompts** — confirmation flow

### Sprint 5: Persistence (days 11-13)

16. **Session JSONL** — write/read/list sessions
17. **Token estimation** — for compaction decisions
18. **Compaction** — cut point detection + LLM summarization
19. **Session resume** — load and continue

### Sprint 6: Config & Skills (day 14)

20. **Config loading** — `tokenius.json` parsing
21. **AGENTS.md** — loading + injection into system prompt
22. **Skills** — discovery, parsing, invocation

### Sprint 7: CLI (days 15-16)

23. **Readline CLI** — input loop, command parsing
24. **Streaming renderer** — chalk-based output
25. **Slash commands** — /help, /sessions, /load, /compact, /skill:\*, /cost

### Sprint 8: Polish (days 17-18)

26. **OpenAI provider** — second provider implementation
27. **Error handling** — context overflow → compaction → retry
28. **Edge cases** — empty responses, network failures, abort handling

### Sprint 9: TUI (later)

29. **TUI framework** — Ink or custom
30. **Rich rendering** — syntax highlighting, spinners, split panes

---

## Directory Structure

```
tokenius/
  src/
    index.ts                     # Entry point
    types.ts                     # All shared type definitions

    providers/
      types.ts                   # Provider, StreamEvent, LLMContext
      registry.ts                # Provider registry (Map-based)
      anthropic.ts               # Anthropic SDK → StreamEvent
      openai.ts                  # OpenAI SDK → StreamEvent
      token-utils.ts             # Cost calculation, token estimation

    tools/
      types.ts                   # ToolDefinition, ToolResult, ToolContext
      registry.ts                # Tool registry
      truncation.ts              # truncateHead, truncateTail
      validation.ts              # JSON Schema validation
      read.ts
      write.ts
      edit.ts
      bash.ts
      grep.ts
      glob.ts
      spawn-agent.ts
      file-lock.ts               # File mutation queue

    agent/
      loop.ts                    # agentLoop() — the core algorithm
      stream.ts                  # streamResponse() — accumulate stream
      execute.ts                 # executeTools() — 3-phase parallel
      agents.ts                  # Built-in agent configs (build, plan, explore)
      system-prompt.ts           # buildSystemPrompt()

    security/
      path-validation.ts         # validatePath()
      command-detection.ts       # checkCommand()
      secrets-detection.ts       # containsSecrets()
      permissions.ts             # Permission prompt flow

    session/
      types.ts                   # SessionEntry, SessionHeader, etc.
      manager.ts                 # create, list, load, append
      compaction.ts              # shouldCompact, findCutPoint, summarize

    skills/
      discovery.ts               # discoverSkills()
      parser.ts                  # parseFrontmatter, parseSkill

    config/
      loader.ts                  # loadConfig(), resolveApiKey()
      agents-md.ts               # loadAgentsMd()

    cli/
      index.ts                   # Main readline loop
      commands.ts                # Slash command handlers
      renderer.ts                # Streaming output rendering (chalk)

  tokenius.json                  # Example project config
  AGENTS.md                      # Project rules
  .tokenius/
    skills/                      # User skills
```
