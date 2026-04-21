// The agent loop — the central orchestration. One function, one while loop,
// everything else is composition:
//
//   stream events → accumulateStream → AssistantMessage → extract tool calls
//     → validateToolCalls → resolveValidatedPermissions → executeToolsSequential
//     → push tool results → back to the top.
//
// Termination is explicit via `stopReason`: "done" (no tool calls), "aborted"
// (user signal), "context_limit" (input tokens past the window reserve),
// "turn_limit" (hit maxTurns), or "error" (unrecoverable exception). The
// default is "turn_limit" so forgetting to set it when the while condition
// lapses is not a silent bug.
//
// `messages` is cloned on entry and returned by reference in the result. The
// input array is never mutated — callers can keep their own reference.

import { addUsage } from "@/providers/cost.ts";
import { getModelMetadata } from "@/providers/models.ts";
import { streamWithRetry } from "@/providers/retry.ts";
import { createPermissionStore, createReadlinePrompter } from "@/security/permissions.ts";
import { getToolSchemas } from "@/tools/registry.ts";

import {
  createContextTracker,
  isContextExhausted,
  updateTokenTracking,
} from "./context-tracker.ts";
import {
  executeToolsSequential,
  resolveValidatedPermissions,
  validateToolCalls,
} from "./execute.ts";
import { accumulateStream } from "./stream.ts";

import type {
  AgentConfig,
  AgentEventHandler,
  AssistantMessage,
  Message,
  Provider,
  ToolCallBlock,
  TokenUsage,
} from "./types.ts";
import type { PermissionPrompter, PermissionStore } from "@/security/permissions.ts";

export type AgentStopReason = "done" | "aborted" | "context_limit" | "turn_limit" | "error";

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0 };

export interface AgentLoopConfig {
  agent: AgentConfig;
  provider: Provider;
  model: string;
  /** Conversation history — user messages + prior assistant + tool results. Not mutated. */
  messages: readonly Message[];
  /** Assembled once by buildSystemPrompt; stable across the session for cache hits. */
  systemPrompt: string;
  cwd: string;
  /**
   * Cancellation signal. Required — callers that don't need to cancel should
   * pass `new AbortController().signal` (never fires). Keeping this mandatory
   * means tool execution always has a concrete signal to forward.
   */
  signal: AbortSignal;
  onEvent?: AgentEventHandler;
  /** Injected for tests / future UIs; defaults to a readline-based prompter. */
  prompter?: PermissionPrompter;
  /**
   * Session-scoped "allow for session" memory. The CLI creates one per user
   * session and reuses it across `agentLoop` calls; subagents inherit the
   * parent's store so the user isn't re-prompted for the same category mid-run.
   * Defaults to a fresh store per call — safe for tests and one-shot usage.
   */
  permissionStore?: PermissionStore;
  /** Override the agent's default maxTurns. */
  maxTurns?: number;
}

export interface AgentLoopResult {
  messages: Message[];
  usage: TokenUsage;
  turns: number;
  stopReason: AgentStopReason;
}

export async function agentLoop(config: AgentLoopConfig): Promise<AgentLoopResult> {
  const { agent, provider, model, systemPrompt, cwd, signal, onEvent } = config;
  const prompter = config.prompter ?? createReadlinePrompter();
  const permissionStore = config.permissionStore ?? createPermissionStore();
  const maxTurns = config.maxTurns ?? agent.maxTurns;
  const messages: Message[] = [...config.messages];

  const modelMeta = getModelMetadata(model);
  const tracker = createContextTracker(model);

  let totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let turn = 0;
  // Default to "turn_limit" so exiting via the while-condition (no break) is
  // reported truthfully. Every other exit path sets this explicitly.
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
          tools: getToolSchemas(agent.tools),
          maxTokens: modelMeta.maxOutputTokens,
        },
        signal,
      );
      assistantMessage = await accumulateStream(stream, onEvent);
    } catch (error) {
      // Abort during streaming surfaces as the SDK's abort error; normalize
      // to our "aborted" stop reason rather than "error".
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
    // accumulateStream always sets usage, but AssistantMessage's type keeps it
    // optional (messages coming from persisted sessions may not have it).
    // Collapse the fallback to one place so the three downstream uses agree.
    const usage = assistantMessage.usage ?? ZERO_USAGE;
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

function extractToolCalls(message: AssistantMessage): ToolCallBlock[] {
  return message.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
}
