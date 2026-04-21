// Scripted Provider for tests. Each `stream()` call consumes the next script
// from the queue and yields its events. Lets us drive the agent loop without
// hitting the network — we hand-write the exact sequence of StreamEvents a
// provider would emit for a given scenario (text response, tool call + args,
// error, etc.).
//
// Used by the Sprint 3 end-to-end loop test and the spawn_agent test.

import type { Provider } from "@/providers/types.ts";
import type { StreamEvent, TokenUsage } from "@/types.ts";

export interface MockProvider extends Provider {
  /** Number of times stream() has been invoked. */
  readonly callCount: number;
}

/**
 * Build a Provider whose stream() yields the next pre-scripted event list on
 * each call. Throws if `stream()` is called more times than scripts provided.
 *
 * @example
 *   const provider = createMockProvider([
 *     [textDelta("Hello"), endTurn()],
 *   ]);
 */
export function createMockProvider(scripts: StreamEvent[][]): MockProvider {
  let calls = 0;
  return {
    id: "anthropic",
    get callCount() {
      return calls;
    },
    async *stream(_model, _context, _signal): AsyncIterable<StreamEvent> {
      const script = scripts[calls];
      calls++;
      if (!script) {
        throw new Error(
          `MockProvider: stream() called ${calls} times but only ${scripts.length} scripts were provided`,
        );
      }
      for (const event of script) {
        yield event;
      }
    },
  };
}

// --- Builders for common event shapes (keeps test files readable) ---

export const messageStart = (): StreamEvent => ({ type: "message_start" });

export const textDelta = (text: string): StreamEvent => ({ type: "text_delta", text });

export const toolCallStart = (id: string, name: string): StreamEvent => ({
  type: "tool_call_start",
  id,
  name,
});

export const toolCallDelta = (args: string): StreamEvent => ({
  type: "tool_call_delta",
  arguments: args,
});

export const toolCallEnd = (): StreamEvent => ({ type: "tool_call_end" });

const DEFAULT_USAGE: TokenUsage = { inputTokens: 10, outputTokens: 5 };

export const messageEnd = (
  usage: TokenUsage = DEFAULT_USAGE,
  stopReason = "end_turn",
): StreamEvent => ({ type: "message_end", usage, stopReason });

/** Shortcut: a whole tool call expressed as its event triple. */
export function toolCall(id: string, name: string, args: Record<string, unknown>): StreamEvent[] {
  return [toolCallStart(id, name), toolCallDelta(JSON.stringify(args)), toolCallEnd()];
}
