// `spawn_agent` is the one tool that IS the agent — it runs a nested agent
// loop. That breaks the usual "tools don't know about agents" separation, so
// it's built as a factory (`createSpawnAgentTool`) that closes over the
// provider, model, cwd, and the parent's onEvent. The parent loop registers
// the resulting ToolDefinition with the tool registry before starting.
//
// Isolation guarantees:
//   - Subagent starts with a fresh message history (just the user prompt).
//   - Subagent gets its own systemPrompt built from its own AgentConfig —
//     build's prompt does not leak down.
//   - Subagent tools are restricted to its AgentConfig.tools list (and
//     `spawn_agent` is deliberately omitted for plan/explore — no recursion).
//   - Parent sees only the final text response; the intermediate message
//     history stays inside the subagent call.
//   - The subagent's own stream of AgentEvents is NOT forwarded to the parent
//     — they'd interleave confusingly with the parent loop's events. The only
//     signal the parent gets is a single `subagent_complete` summary emitted
//     after the child finishes.
//
// Cost is reported to the parent via `onEvent` (not the tool result) so the
// UI can show it alongside other progress — the LLM parent doesn't need to
// see dollar amounts.

import { AGENTS, getAgent } from "@/agent/agents.ts";
import { agentLoop } from "@/agent/loop.ts";
import { buildSystemPrompt } from "@/agent/system-prompt.ts";
import { calculateCost } from "@/providers/cost.ts";

import type { ToolDefinition } from "./types.ts";
import type { AgentStopReason } from "@/agent/loop.ts";
import type { AgentEventHandler, AgentConfig } from "@/agent/types.ts";
import type { Provider } from "@/providers/types.ts";
import type { PermissionPrompter, PermissionStore } from "@/security/permissions.ts";
import type { AssistantMessage, Message, TextBlock } from "@/types.ts";

export interface CreateSpawnAgentToolOptions {
  provider: Provider;
  model: string;
  cwd: string;
  /**
   * Parent's event handler. The subagent's raw events are NOT forwarded; the
   * parent only receives `subagent_complete` (summary) when the child finishes.
   */
  onEvent?: AgentEventHandler;
  /** Optional agentsMd passed into the subagent's system prompt. */
  agentsMd?: string | null;
  /** Optional permission prompter; subagent inherits parent's flow. */
  prompter?: PermissionPrompter;
  /**
   * Parent's permission store. Passing it through avoids re-prompting the user
   * for a category they already approved for this session.
   */
  permissionStore?: PermissionStore;
}

interface SpawnAgentParams {
  agent: string;
  prompt: string;
}

const SUBAGENT_NAMES = Object.keys(AGENTS).filter((name) => name !== "build");

export function createSpawnAgentTool(
  options: CreateSpawnAgentToolOptions,
): ToolDefinition<SpawnAgentParams> {
  return {
    name: "spawn_agent",
    description: `Spawn a subagent for a focused subtask. Available agents:
- "plan": Planning and analysis. Reads code but cannot modify. Use for architecture, design, code review.
- "explore": Fast codebase exploration. Use to find files, search patterns, or understand structure.
The subagent returns its final text response; its intermediate messages are not visible.`,
    parameters: {
      type: "object",
      properties: {
        agent: {
          type: "string",
          description: "Which subagent to spawn.",
          enum: SUBAGENT_NAMES as readonly string[],
        },
        prompt: {
          type: "string",
          description: "Task description for the subagent.",
        },
      },
      required: ["agent", "prompt"],
    },
    async execute(params, context) {
      const agentConfig: AgentConfig | undefined = getAgent(params.agent);
      if (!agentConfig) {
        return { content: `Unknown subagent: ${params.agent}`, isError: true };
      }
      if (agentConfig.name === "build") {
        // Defensive: never recurse into the top-level build loop via this tool.
        return { content: `Cannot spawn build agent via spawn_agent`, isError: true };
      }

      const subSystemPrompt = buildSystemPrompt({
        agent: agentConfig,
        agentsMd: options.agentsMd ?? null,
      });

      const result = await agentLoop({
        agent: agentConfig,
        provider: options.provider,
        model: options.model,
        messages: [{ role: "user", content: params.prompt }],
        systemPrompt: subSystemPrompt,
        cwd: options.cwd,
        signal: context.signal,
        // Intentionally NOT forwarding options.onEvent — see file-header note.
        ...(options.prompter && { prompter: options.prompter }),
        ...(options.permissionStore && { permissionStore: options.permissionStore }),
      });

      const text = extractFinalText(result.messages);

      options.onEvent?.({
        type: "subagent_complete",
        agent: agentConfig.name,
        turns: result.turns,
        tokens: result.usage.inputTokens + result.usage.outputTokens,
        cost: calculateCost(options.model, result.usage),
      });

      return buildResult(result.stopReason, text);
    },
  };
}

/**
 * Translate subagent stop reasons into a ToolResult for the parent. Only
 * `done` is a clean success; everything else surfaces as isError with context
 * so the parent LLM can react (retry, give up, ask for clarification) rather
 * than treating partial output as a finished answer.
 */
function buildResult(
  stopReason: AgentStopReason,
  text: string,
): { content: string; isError?: boolean } {
  if (stopReason === "done") {
    return { content: text || "(subagent produced no response)" };
  }

  const label = STOP_REASON_LABEL[stopReason];
  const body = text ? `${text}\n\n[subagent ${label}]` : `(subagent ${label})`;
  return { content: body, isError: true };
}

const STOP_REASON_LABEL: Record<Exclude<AgentStopReason, "done">, string> = {
  error: "errored",
  aborted: "aborted",
  turn_limit: "hit turn limit",
  context_limit: "hit context limit",
};

function extractFinalText(messages: readonly Message[]): string {
  // Walk backwards to the last assistant message and join its text blocks.
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role === "assistant") {
      return assistantText(msg);
    }
  }
  return "";
}

function assistantText(msg: AssistantMessage): string {
  return msg.content
    .filter((block): block is TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}
