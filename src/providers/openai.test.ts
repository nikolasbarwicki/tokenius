// Provider-level tests for OpenAI. We don't test the SDK itself — the
// integration is covered by the Anthropic-style smoke tests when run with a
// real API key. These tests pin the two things we own:
//
//   1. Message conversion from our canonical format to OpenAI's.
//   2. Stream-event mapping in mapChunks (tool calls by index, usage merging,
//      stop-reason normalization).
//
// The provider's public surface doesn't expose the internals, so we inject
// chunks through a mock client via module internals. Instead of monkey-patching
// the SDK, we invoke the internal helpers by importing the module's source —
// except they're private. Pragmatic workaround: re-implement a thin harness
// that exercises `mapChunks` shape indirectly through a fake async iterable.
//
// We take the lower-friction path: re-exported `__testables` below. See
// openai.ts.

import { describe, expect, it } from "bun:test";

import {
  __testables,
  // createOpenAIProvider, // Not exercised here — needs a live client.
} from "./openai.ts";

import type { StreamEvent } from "@/types.ts";
import type { ChatCompletionChunk } from "openai/resources/chat/completions/completions";

const { mapChunks, convertMessages, convertTools, normalizeStopReason } = __testables;

function chunk(
  delta: ChatCompletionChunk.Choice.Delta,
  opts: Partial<ChatCompletionChunk> = {},
): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5.4-mini",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...opts,
  };
}

type Usage = NonNullable<ChatCompletionChunk["usage"]>;

function finalChunk(
  finishReason: NonNullable<ChatCompletionChunk.Choice["finish_reason"]>,
  usage: Usage,
): ChatCompletionChunk {
  return {
    id: "c1",
    object: "chat.completion.chunk",
    created: 0,
    model: "gpt-5.4-mini",
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    usage,
  };
}

async function collect(chunks: ChatCompletionChunk[]): Promise<StreamEvent[]> {
  async function* gen(): AsyncGenerator<ChatCompletionChunk> {
    for (const c of chunks) {
      yield c;
    }
  }
  const out: StreamEvent[] = [];
  for await (const ev of mapChunks(gen())) {
    out.push(ev);
  }
  return out;
}

describe("openai — mapChunks", () => {
  it("emits text deltas and a message_end with usage on stop", async () => {
    const events = await collect([
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }),
      finalChunk("stop", { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
    ]);

    expect(events).toEqual([
      { type: "text_delta", text: "Hel" },
      { type: "text_delta", text: "lo" },
      {
        type: "message_end",
        usage: { inputTokens: 12, outputTokens: 3 },
        stopReason: "stop",
      },
    ]);
  });

  it("maps a single tool call: start, deltas, end, tool_use stop", async () => {
    const events = await collect([
      chunk({
        tool_calls: [
          { index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: "" } },
        ],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: '{"command"' } }],
      }),
      chunk({
        tool_calls: [{ index: 0, function: { arguments: ':"ls"}' } }],
      }),
      finalChunk("tool_calls", { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 }),
    ]);

    expect(events).toEqual([
      { type: "tool_call_start", id: "call_1", name: "bash" },
      { type: "tool_call_delta", arguments: '{"command"' },
      { type: "tool_call_delta", arguments: ':"ls"}' },
      { type: "tool_call_end" },
      {
        type: "message_end",
        usage: { inputTokens: 20, outputTokens: 8 },
        stopReason: "tool_use",
      },
    ]);
  });

  it("closes the previous tool call when a new index appears", async () => {
    const events = await collect([
      chunk({
        tool_calls: [
          { index: 0, id: "a", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 1, id: "b", type: "function", function: { name: "glob", arguments: "{}" } },
        ],
      }),
      finalChunk("tool_calls", { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 }),
    ]);

    expect(events).toEqual([
      { type: "tool_call_start", id: "a", name: "read" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "b", name: "glob" },
      { type: "tool_call_delta", arguments: "{}" },
      { type: "tool_call_end" },
      {
        type: "message_end",
        usage: { inputTokens: 5, outputTokens: 5 },
        stopReason: "tool_use",
      },
    ]);
  });

  it("forwards cached_tokens as cacheReadTokens (no cacheWrite)", async () => {
    const events = await collect([
      chunk({ content: "hi" }),
      finalChunk("stop", {
        prompt_tokens: 100,
        completion_tokens: 1,
        total_tokens: 101,
        prompt_tokens_details: { cached_tokens: 40 },
      }),
    ]);

    const end = events.at(-1);
    expect(end).toEqual({
      type: "message_end",
      usage: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 40 },
      stopReason: "stop",
    });
  });

  it("drops empty text deltas and ignores empty choice arrays", async () => {
    const events = await collect([
      { ...chunk({ content: "" }), choices: [] },
      chunk({ content: "ok" }),
      finalChunk("stop", { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }),
    ]);

    expect(events.filter((e) => e.type === "text_delta")).toEqual([
      { type: "text_delta", text: "ok" },
    ]);
  });
});

describe("openai — convertMessages", () => {
  it("prepends the system prompt", () => {
    const out = convertMessages("you are helpful", [{ role: "user", content: "hi" }]);
    expect(out[0]).toEqual({ role: "system", content: "you are helpful" });
    expect(out[1]).toEqual({ role: "user", content: "hi" });
  });

  it("merges assistant text and tool_calls into a single message", () => {
    const out = convertMessages("sys", [
      {
        role: "assistant",
        content: [
          { type: "text", text: "calling " },
          { type: "text", text: "bash" },
          { type: "tool_call", id: "t1", name: "bash", arguments: { command: "ls" } },
        ],
      },
    ]);
    expect(out[1]).toEqual({
      role: "assistant",
      content: "calling bash",
      tool_calls: [
        { id: "t1", type: "function", function: { name: "bash", arguments: '{"command":"ls"}' } },
      ],
    });
  });

  it("drops thinking blocks on the openai dialect", () => {
    const out = convertMessages("sys", [
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret" },
          { type: "text", text: "visible" },
        ],
      },
    ]);
    expect(out[1]).toEqual({ role: "assistant", content: "visible" });
  });

  it("maps tool_result to role: tool and prefixes errors", () => {
    const out = convertMessages("sys", [
      { role: "tool_result", toolCallId: "t1", toolName: "bash", content: "output" },
      {
        role: "tool_result",
        toolCallId: "t2",
        toolName: "bash",
        content: "boom",
        isError: true,
      },
    ]);
    expect(out.slice(1)).toEqual([
      { role: "tool", tool_call_id: "t1", content: "output" },
      { role: "tool", tool_call_id: "t2", content: "ERROR: boom" },
    ]);
  });
});

describe("openai — convertTools", () => {
  it("returns undefined when no tools", () => {
    expect(convertTools([])).toBeUndefined();
  });

  it("wraps schemas in function-tool envelopes", () => {
    expect(
      convertTools([{ name: "read", description: "read a file", inputSchema: { type: "object" } }]),
    ).toEqual([
      {
        type: "function",
        function: { name: "read", description: "read a file", parameters: { type: "object" } },
      },
    ]);
  });
});

describe("openai — normalizeStopReason", () => {
  const cases: [string | null, "stop" | "tool_use" | "length" | "error"][] = [
    ["tool_calls", "tool_use"],
    ["length", "length"],
    ["content_filter", "error"],
    ["stop", "stop"],
    ["function_call", "stop"],
    [null, "stop"],
    ["unknown", "stop"],
  ];
  it.each(cases)("%s → %s", (raw, expected) => {
    expect(normalizeStopReason(raw)).toBe(expected);
  });
});
