// Stream accumulator: consumes StreamEvent deltas and assembles a single
// AssistantMessage. Also forwards UI-facing deltas to `onEvent`.
//
// Two invariants this file protects:
//   1. Text/thinking deltas always extend the *most recent* block of that
//      kind. If the stream interleaves text → tool_call → text, that's two
//      separate TextBlocks — the tool_call in between breaks the run.
//   2. Tool-call arguments are accumulated per-id in a raw string, then
//      parsed with parsePartialJson on tool_call_end. Multiple tool calls
//      in the same turn each get their own buffer.
//
// The partial-JSON recovery is the reason we don't parse incrementally: a
// stream can be interrupted mid-arguments and we'd rather repair-and-try
// than lose the whole tool call.

import { parsePartialJson } from "@/providers/partial-json.ts";

import type { AgentEventHandler } from "./types.ts";
import type {
  AssistantContent,
  AssistantMessage,
  StreamEvent,
  TokenUsage,
  ToolCallBlock,
} from "@/types.ts";

type StopReason = NonNullable<AssistantMessage["stopReason"]>;

const VALID_STOP_REASONS: readonly StopReason[] = ["stop", "tool_use", "length", "error"];

// Providers are expected to ship canonical stopReasons; this is a last-resort
// guard so a buggy provider can't smuggle an off-spec string into a persisted
// session.
function coerceStopReason(raw: string): StopReason {
  return (VALID_STOP_REASONS as readonly string[]).includes(raw) ? (raw as StopReason) : "stop";
}

/**
 * Consume a stream of provider events and return a complete AssistantMessage.
 * Forwards deltas to `onEvent` as they arrive so the UI can stream output.
 *
 * Throws if the stream yields an `error` event, or if the stream ends without
 * a `message_end` (partial response). The caller (agent loop) decides whether
 * to retry.
 */
export async function accumulateStream(
  events: AsyncIterable<StreamEvent>,
  onEvent?: AgentEventHandler,
): Promise<AssistantMessage> {
  const content: AssistantContent[] = [];
  /** Raw partial-JSON buffer per tool_call id. */
  const toolCallBuffers = new Map<string, string>();
  /** id of the tool_call currently receiving deltas (null outside a block). */
  let activeToolCallId: string | null = null;

  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let stopReason: StopReason = "stop";
  let sawMessageEnd = false;

  for await (const event of events) {
    switch (event.type) {
      case "message_start":
        // Provider-level bookkeeping; no content yet.
        break;

      case "text_delta":
        appendToLastTextBlock(content, event.text);
        onEvent?.({ type: "text_delta", text: event.text });
        break;

      case "thinking_delta":
        appendToLastThinkingBlock(content, event.thinking);
        onEvent?.({ type: "thinking_delta", thinking: event.thinking });
        break;

      case "tool_call_start": {
        const block: ToolCallBlock = {
          type: "tool_call",
          id: event.id,
          name: event.name,
          arguments: {},
        };
        content.push(block);
        toolCallBuffers.set(event.id, "");
        activeToolCallId = event.id;
        onEvent?.({ type: "tool_call_start", name: event.name, id: event.id });
        break;
      }

      case "tool_call_delta": {
        if (activeToolCallId === null) {
          // Delta without a matching start — drop it. Providers shouldn't emit
          // this but we don't want to crash on a malformed stream.
          break;
        }
        const buffered = (toolCallBuffers.get(activeToolCallId) ?? "") + event.arguments;
        toolCallBuffers.set(activeToolCallId, buffered);
        const activeBlock = content.at(-1);
        const name = activeBlock?.type === "tool_call" ? activeBlock.name : "";
        onEvent?.({ type: "tool_call_args", name, partialArgs: buffered });
        break;
      }

      case "tool_call_end": {
        if (activeToolCallId === null) {
          break;
        }
        const id = activeToolCallId;
        const raw = toolCallBuffers.get(id) ?? "";
        const block = content.find(
          (b): b is ToolCallBlock => b.type === "tool_call" && b.id === id,
        );
        if (block) {
          // Empty args buffer is legal (some tools have no required params) —
          // parsePartialJson returns {} for "" after the try/catch.
          block.arguments =
            raw.trim().length === 0 ? {} : parsePartialJson<Record<string, unknown>>(raw);
        }
        activeToolCallId = null;
        break;
      }

      case "message_end":
        usage = event.usage;
        stopReason = coerceStopReason(event.stopReason);
        sawMessageEnd = true;
        break;

      case "error":
        throw event.error;
    }
  }

  if (!sawMessageEnd) {
    throw new Error("Stream ended before message_end event");
  }

  return { role: "assistant", content, usage, stopReason };
}

// --- Block-append helpers ---
//
// Text and thinking blocks are "runs": consecutive deltas of the same kind
// merge into one block, but any other block type (e.g. a tool_call inserted
// between them) breaks the run and the next delta starts a fresh block.

function appendToLastTextBlock(content: AssistantContent[], text: string): void {
  const last = content.at(-1);
  if (last?.type === "text") {
    last.text += text;
    return;
  }
  content.push({ type: "text", text });
}

function appendToLastThinkingBlock(content: AssistantContent[], thinking: string): void {
  const last = content.at(-1);
  if (last?.type === "thinking") {
    last.thinking += thinking;
    return;
  }
  content.push({ type: "thinking", thinking });
}
