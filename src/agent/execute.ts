// Tool execution for the agent loop. Three phases kept as three functions so
// each can be tested in isolation:
//
//   1. validateToolCalls   — JSON-schema validation + security pre-check.
//                            Bash is the one tool whose command-detection runs
//                            here (not just inside the tool) so we can batch
//                            permission prompts upfront.
//
//   2. resolveValidatedPermissions — adjudicates collected permission requests
//                            against session memory + prompter. Mutates
//                            results: denied calls become errors.
//
//   3. executeToolsSequential — runs approved tools in order, truncates
//                            output, wraps results as ToolResultMessages.
//
// Truncation direction is picked per-tool: bash → truncateTail (errors at the
// bottom of long output), everyone else → truncateHead.

import { checkCommand } from "@/security/command-detection.ts";
import { resolvePermissions } from "@/security/permissions.ts";
import { getTool } from "@/tools/registry.ts";
import { truncateHead, truncateTail } from "@/tools/truncation.ts";
import { validateArgs } from "@/tools/validation.ts";

import type { AgentEventHandler } from "./types.ts";
import type {
  PermissionPrompter,
  PermissionRequest,
  PermissionStore,
} from "@/security/permissions.ts";
import type { ToolDefinition, ToolResult } from "@/tools/types.ts";
import type { ToolCallBlock, ToolResultMessage } from "@/types.ts";

export interface ValidatedToolCall {
  call: ToolCallBlock;
  tool: ToolDefinition | null;
  /** Set if this call cannot be executed (unknown tool, bad args, blocked, denied). */
  error?: string;
  /** Set if this call needs user confirmation before executing. */
  pendingPermission?: PermissionRequest;
}

/**
 * Validate a batch of tool calls. Performs JSON-schema checks and, for bash,
 * runs command-detection to distinguish blocked / allowed / needs-confirm.
 *
 * When `allowedTools` is passed, tool calls outside that set are rejected as
 * errors. This is defense-in-depth: the LLM only receives schemas it's allowed
 * to call, but a malformed stream or a recycled message history could include
 * a tool name the current agent isn't supposed to run.
 *
 * Never prompts or executes — that's the caller's job. Returns results in the
 * same order as the input.
 */
export function validateToolCalls(
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

    // Bash is the only tool that can be blocked outright or need confirmation.
    // Pre-checking here (rather than only inside bash.ts) lets the loop
    // batch-prompt before any execution starts.
    if (call.name === "bash") {
      const command = (call.arguments as { command?: unknown }).command;
      if (typeof command === "string") {
        const check = checkCommand(command);
        if (!check.allowed) {
          results.push({ call, tool, error: `bash blocked: ${check.reason ?? "unsafe command"}` });
          continue;
        }
        if (check.requiresConfirmation) {
          results.push({
            call,
            tool,
            pendingPermission: {
              tool: "bash",
              description: command,
              reason: check.reason ?? "destructive command",
            },
          });
          continue;
        }
      }
    }

    results.push({ call, tool });
  }

  return results;
}

/**
 * Resolve outstanding permission requests. Mutates `validated` in place:
 * approved calls lose their `pendingPermission`; denied calls gain an `error`.
 * Calls that had no pending permission are untouched.
 */
export async function resolveValidatedPermissions(
  validated: ValidatedToolCall[],
  prompter: PermissionPrompter,
  store: PermissionStore,
): Promise<void> {
  const pending = validated.filter((v) => v.pendingPermission !== undefined);
  if (pending.length === 0) {
    return;
  }

  const decisions = await resolvePermissions(
    pending.map((v) => v.pendingPermission as PermissionRequest),
    prompter,
    store,
  );

  for (const [i, decision] of decisions.entries()) {
    const target = pending[i];
    if (!target || !target.pendingPermission) {
      continue;
    }
    if (decision === "deny") {
      target.error = `User denied permission: ${target.pendingPermission.reason}`;
    }
    delete target.pendingPermission;
  }
}

/**
 * Execute validated tool calls in order. Errors (unknown tool, bad args,
 * blocked, denied) skip execution and emit an error ToolResultMessage.
 * Output is truncated before reaching the LLM — this is the one invariant
 * the loop enforces: the model never sees unbounded content.
 */
export async function executeToolsSequential(
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
      results.push({
        role: "tool_result",
        toolCallId: v.call.id,
        toolName: v.call.name,
        content: "aborted before execution",
        isError: true,
      });
      continue;
    }

    if (v.error || !v.tool) {
      const errorMsg = v.error ?? `Unknown tool: ${v.call.name}`;
      results.push({
        role: "tool_result",
        toolCallId: v.call.id,
        toolName: v.call.name,
        content: errorMsg,
        isError: true,
      });
      onEvent?.({
        type: "tool_result",
        name: v.call.name,
        result: { content: errorMsg, isError: true },
      });
      continue;
    }

    let result: ToolResult;
    try {
      result = await v.tool.execute(v.call.arguments, {
        cwd,
        signal,
        // Permission was pre-resolved upfront by resolveValidatedPermissions.
        // Tools that still check context.confirm see an auto-approve because
        // denial would already have become v.error above.
        confirm: () => Promise.resolve(true),
      });
    } catch (error) {
      // One tool throwing does NOT abort the batch: the LLM sees the error
      // result next turn and decides whether the remaining tools are still
      // useful. Stopping here would force it to re-plan blind.
      const message = error instanceof Error ? error.message : String(error);
      result = { content: `${v.call.name} threw: ${message}`, isError: true };
    }

    const truncated =
      v.call.name === "bash" ? truncateTail(result.content) : truncateHead(result.content);

    const resultMsg: ToolResultMessage = {
      role: "tool_result",
      toolCallId: v.call.id,
      toolName: v.call.name,
      content: truncated.content,
      ...(result.isError !== undefined && { isError: result.isError }),
    };
    results.push(resultMsg);

    onEvent?.({ type: "tool_result", name: v.call.name, result });
  }

  return results;
}
