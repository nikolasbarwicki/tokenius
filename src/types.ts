// --- Provider ---

export type ProviderId = "anthropic" | "openai";

// --- Token tracking ---

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// --- Assistant content blocks ---

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
}

export interface ToolCallBlock {
  type: "tool_call";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock;

// --- Messages ---

export interface UserMessage {
  role: "user";
  content: string;
}

export interface AssistantMessage {
  role: "assistant";
  content: AssistantContent[];
  usage?: TokenUsage;
  stopReason?: "stop" | "tool_use" | "length" | "error";
}

export interface ToolResultMessage {
  role: "tool_result";
  toolCallId: string;
  toolName: string;
  content: string;
  isError?: boolean;
}

export type Message = UserMessage | AssistantMessage | ToolResultMessage;

// --- Streaming events (discriminated union) ---

export type StreamEvent =
  | { type: "message_start" }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; arguments: string }
  | { type: "tool_call_end" }
  | { type: "message_end"; usage: TokenUsage; stopReason: string }
  | { type: "error"; error: Error };

// --- Tool schema (used by LLMContext, full tool system in Sprint 2) ---

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
