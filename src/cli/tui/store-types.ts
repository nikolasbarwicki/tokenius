// Block and state types. Kept separate from the reducer so both store.ts and
// store-event.ts can import without a cycle.

import type { AgentEvent } from "@/agent/types.ts";
import type { PermissionRequest } from "@/security/permissions.ts";
import type { ToolResult } from "@/tools/types.ts";

// --- Block shapes ---

export interface UserBlock {
  kind: "user";
  id: string;
  text: string;
}

export interface TextBlock {
  kind: "text";
  id: string;
  text: string;
}

export interface ThinkingBlock {
  kind: "thinking";
  id: string;
  text: string;
}

export interface ToolCallBlock {
  kind: "tool_call";
  id: string;
  name: string;
  rawArgs: string;
  /** Filled in when tool_result arrives. */
  result?: ToolResult;
}

export interface SystemBlock {
  kind: "system";
  id: string;
  text: string;
  tone: "info" | "warn" | "error";
}

export interface FooterBlock {
  kind: "footer";
  id: string;
  usage: { inputTokens: number; outputTokens: number };
  cost: number;
}

export type Block =
  | UserBlock
  | TextBlock
  | ThinkingBlock
  | ToolCallBlock
  | SystemBlock
  | FooterBlock;

// --- Status ---

export type Status = { kind: "idle" } | { kind: "thinking" } | { kind: "running"; tool: string };

// --- Store state ---

export interface PermissionModalState {
  requests: readonly PermissionRequest[];
  /** Index of the request currently being asked. */
  index: number;
  /** Accumulated responses — length === index while prompting. */
  responses: ("allow" | "deny" | "allow_session")[];
}

export interface StoreState {
  staticBlocks: Block[];
  liveBlocks: Block[];
  status: Status;
  permission: PermissionModalState | null;
  context: { usedTokens: number; windowTokens: number };
  cumulative: { inputTokens: number; outputTokens: number; cost: number };
  /** True when agentLoop is running — used to gate input. */
  busy: boolean;
}

// --- Actions ---

export type Action =
  | { type: "event"; event: AgentEvent }
  | { type: "user_submit"; text: string }
  | { type: "system_message"; text: string; tone?: "info" | "warn" | "error" }
  | { type: "turn_started" }
  | {
      type: "turn_finished";
      usage: { inputTokens: number; outputTokens: number };
      cost: number;
    }
  | { type: "permission_request"; requests: readonly PermissionRequest[] }
  | {
      type: "permission_answer";
      response: "allow" | "deny" | "allow_session";
    }
  | { type: "permission_cancel" };
