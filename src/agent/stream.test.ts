import { describe, expect, it } from "bun:test";

import { accumulateStream } from "./stream.ts";

import type { AgentEvent } from "./types.ts";
import type { StreamEvent, TextBlock, ThinkingBlock, ToolCallBlock } from "@/types.ts";

async function* fromArray(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) {
    yield e;
  }
}

const DEFAULT_USAGE = { inputTokens: 10, outputTokens: 5 };

const endEvent = (
  usage: { inputTokens: number; outputTokens: number } = DEFAULT_USAGE,
  stopReason = "end_turn",
): StreamEvent => ({ type: "message_end", usage, stopReason });

describe("accumulateStream", () => {
  it("assembles a text-only message", async () => {
    const stream = fromArray([
      { type: "message_start" },
      { type: "text_delta", text: "Hello" },
      { type: "text_delta", text: ", world!" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.role).toBe("assistant");
    expect(msg.content).toEqual([{ type: "text", text: "Hello, world!" }]);
    expect(msg.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("merges consecutive text deltas into a single block", async () => {
    const stream = fromArray([
      { type: "text_delta", text: "a" },
      { type: "text_delta", text: "b" },
      { type: "text_delta", text: "c" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.content).toHaveLength(1);
    expect((msg.content[0] as TextBlock).text).toBe("abc");
  });

  it("merges consecutive thinking deltas into a single block", async () => {
    const stream = fromArray([
      { type: "thinking_delta", thinking: "step 1." },
      { type: "thinking_delta", thinking: " step 2." },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.content).toHaveLength(1);
    expect((msg.content[0] as ThinkingBlock).thinking).toBe("step 1. step 2.");
  });

  it("splits text/tool_call/text into three blocks (tool_call breaks the run)", async () => {
    const stream = fromArray([
      { type: "text_delta", text: "before" },
      { type: "tool_call_start", id: "t1", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":"a.txt"}' },
      { type: "tool_call_end" },
      { type: "text_delta", text: "after" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.content).toHaveLength(3);
    expect(msg.content[0]).toEqual({ type: "text", text: "before" });
    expect(msg.content[1]).toEqual({
      type: "tool_call",
      id: "t1",
      name: "read",
      arguments: { path: "a.txt" },
    });
    expect(msg.content[2]).toEqual({ type: "text", text: "after" });
  });

  it("accumulates chunked tool arguments across multiple deltas", async () => {
    const stream = fromArray([
      { type: "tool_call_start", id: "t1", name: "grep" },
      { type: "tool_call_delta", arguments: '{"pat' },
      { type: "tool_call_delta", arguments: 'tern":"foo",' },
      { type: "tool_call_delta", arguments: '"path":"src"}' },
      { type: "tool_call_end" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect((msg.content[0] as ToolCallBlock).arguments).toEqual({ pattern: "foo", path: "src" });
  });

  it("handles multiple tool calls in the same turn with separate buffers", async () => {
    const stream = fromArray([
      { type: "tool_call_start", id: "a", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":"a.txt"}' },
      { type: "tool_call_end" },
      { type: "tool_call_start", id: "b", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":"b.txt"}' },
      { type: "tool_call_end" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.content).toHaveLength(2);
    expect((msg.content[0] as ToolCallBlock).arguments).toEqual({ path: "a.txt" });
    expect((msg.content[1] as ToolCallBlock).arguments).toEqual({ path: "b.txt" });
  });

  it("repairs truncated tool arguments via parsePartialJson", async () => {
    // Stream interrupted mid-value — parser should close the string + brace.
    const stream = fromArray([
      { type: "tool_call_start", id: "t1", name: "write" },
      { type: "tool_call_delta", arguments: '{"path":"a.txt","content":"hel' },
      { type: "tool_call_end" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect((msg.content[0] as ToolCallBlock).arguments).toEqual({
      path: "a.txt",
      content: "hel",
    });
  });

  it("treats an empty argument buffer as {} (no JSON parse on '')", async () => {
    const stream = fromArray([
      { type: "tool_call_start", id: "t1", name: "noparams" },
      { type: "tool_call_end" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect((msg.content[0] as ToolCallBlock).arguments).toEqual({});
  });

  it("forwards deltas to onEvent in order", async () => {
    const events: AgentEvent[] = [];
    const stream = fromArray([
      { type: "text_delta", text: "x" },
      { type: "tool_call_start", id: "t", name: "read" },
      { type: "tool_call_delta", arguments: '{"path":' },
      { type: "tool_call_delta", arguments: '"a"}' },
      { type: "tool_call_end" },
      { type: "text_delta", text: "y" },
      endEvent(),
    ]);
    await accumulateStream(stream, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual([
      "text_delta",
      "tool_call_start",
      "tool_call_args",
      "tool_call_args",
      "text_delta",
    ]);
    // Partial args should be cumulative per delta.
    const args = events.filter((e) => e.type === "tool_call_args") as Extract<
      AgentEvent,
      { type: "tool_call_args" }
    >[];
    expect(args[0]?.partialArgs).toBe('{"path":');
    expect(args[1]?.partialArgs).toBe('{"path":"a"}');
  });

  it("captures usage and stopReason from message_end", async () => {
    const stream = fromArray([
      { type: "text_delta", text: "ok" },
      endEvent({ inputTokens: 123, outputTokens: 45 }, "tool_use"),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.usage).toEqual({ inputTokens: 123, outputTokens: 45 });
    expect(msg.stopReason).toBe("tool_use");
  });

  it("normalizes unknown stopReason values to 'stop'", async () => {
    const stream = fromArray([endEvent(undefined, "end_turn")]);
    const msg = await accumulateStream(stream);
    expect(msg.stopReason).toBe("stop");
  });

  it("throws on an error event", async () => {
    const boom = new Error("stream boom");
    const stream = fromArray([
      { type: "text_delta", text: "oh" },
      { type: "error", error: boom },
    ]);
    await expect(accumulateStream(stream)).rejects.toThrow("stream boom");
  });

  it("throws when the stream ends without message_end", async () => {
    const stream = fromArray([{ type: "text_delta", text: "truncated" }]);
    await expect(accumulateStream(stream)).rejects.toThrow(/message_end/);
  });

  it("ignores tool_call_delta/end arriving without a start", async () => {
    const stream = fromArray([
      { type: "tool_call_delta", arguments: '{"x":1}' },
      { type: "tool_call_end" },
      { type: "text_delta", text: "done" },
      endEvent(),
    ]);
    const msg = await accumulateStream(stream);
    expect(msg.content).toEqual([{ type: "text", text: "done" }]);
  });
});
