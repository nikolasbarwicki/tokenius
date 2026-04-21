// Shared agent-layer types. Kept in their own file to avoid circular imports
// between loop.ts, stream.ts, execute.ts, and spawn-agent.ts.

import type { ToolResult } from "@/tools/types.ts";
import type { TokenUsage } from "@/types.ts";

export type { Provider } from "@/providers/types.ts";
export type { AssistantMessage, Message, ToolCallBlock, TokenUsage } from "@/types.ts";

// --- Agent configuration ---

export interface AgentConfig {
  name: string;
  description: string;
  systemPrompt: string;
  /** Tool names this agent is allowed to call. Drives the schema list. */
  tools: readonly string[];
  maxTurns: number;
}

// --- Events emitted to the UI ---
//
// The loop is UI-agnostic: it calls onEvent(...) and a renderer decides what
// to show. Streaming deltas are forwarded as-is; per-turn lifecycle events let
// the UI show spinners, turn counters, costs, etc.

export type AgentEvent =
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

export type AgentEventHandler = (event: AgentEvent) => void;
