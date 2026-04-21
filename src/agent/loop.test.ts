/* oxlint-disable eslint/max-lines --
 * End-to-end agent loop tests cover every terminal state (done, aborted,
 * context_limit, turn_limit, error) plus multi-turn tool cycles and the
 * empty-response retry. The 300-line cap is useful for source files; for a
 * suite this exhaustive, listing each scenario explicitly beats cramming. */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  createMockProvider,
  messageEnd,
  messageStart,
  textDelta,
  toolCall,
} from "@/testing/mock-provider.ts";
import { clearTools, registerTool } from "@/tools/registry.ts";

import { agentLoop } from "./loop.ts";

import type { AgentConfig, AgentEvent } from "./types.ts";
import type { PermissionPrompter } from "@/security/permissions.ts";
import type { ToolDefinition } from "@/tools/types.ts";
import type { AssistantMessage, Message, ToolResultMessage } from "@/types.ts";

const MODEL = "claude-haiku-4-5-20251001";

const denyPrompter: PermissionPrompter = (requests) => Promise.resolve(requests.map(() => "deny"));

const echoTool: ToolDefinition<{ text: string }> = {
  name: "echo",
  description: "Return the input text unchanged.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: (params) => Promise.resolve({ content: `echo: ${params.text}` }),
};

const testAgent: AgentConfig = {
  name: "test",
  description: "test agent",
  systemPrompt: "you are a test",
  tools: ["echo"],
  maxTurns: 5,
};

const userMsg = (content: string): Message => ({ role: "user", content });

function run(
  overrides: Partial<Parameters<typeof agentLoop>[0]> & {
    provider: Parameters<typeof agentLoop>[0]["provider"];
    messages?: readonly Message[];
  },
) {
  return agentLoop({
    agent: testAgent,
    model: MODEL,
    systemPrompt: "system",
    cwd: process.cwd(),
    messages: overrides.messages ?? [userMsg("hi")],
    signal: new AbortController().signal,
    prompter: denyPrompter,
    ...overrides,
  });
}

beforeEach(() => {
  clearTools();
  registerTool(echoTool as unknown as ToolDefinition);
});

afterEach(() => {
  clearTools();
});

describe("agentLoop", () => {
  it("returns 'done' after a single text-only turn", async () => {
    const provider = createMockProvider([[messageStart(), textDelta("Hello!"), messageEnd()]]);

    const result = await run({ provider });

    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(1);
    expect(result.messages).toHaveLength(2); // user + assistant
    const assistant = result.messages[1] as AssistantMessage;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toEqual([{ type: "text", text: "Hello!" }]);
    expect(provider.callCount).toBe(1);
  });

  it("runs a tool call and returns its result in a second turn", async () => {
    const provider = createMockProvider([
      // Turn 1: model calls echo
      [
        messageStart(),
        ...toolCall("call-1", "echo", { text: "ping" }),
        messageEnd({ inputTokens: 20, outputTokens: 10 }, "tool_use"),
      ],
      // Turn 2: model reads the tool result and concludes
      [messageStart(), textDelta("Got: echo: ping"), messageEnd()],
    ]);

    const events: AgentEvent[] = [];
    const result = await run({ provider, onEvent: (e) => events.push(e) });

    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(2);
    // user + assistant(tool_call) + tool_result + assistant(text)
    expect(result.messages).toHaveLength(4);
    const toolResult = result.messages[2] as ToolResultMessage;
    expect(toolResult.role).toBe("tool_result");
    expect(toolResult.toolName).toBe("echo");
    expect(toolResult.content).toBe("echo: ping");
    expect(toolResult.isError).toBeUndefined();

    // Usage aggregated across both turns.
    expect(result.usage.inputTokens).toBe(30);
    expect(result.usage.outputTokens).toBe(15);

    // Events include both turn_starts and the tool_result.
    expect(events.filter((e) => e.type === "turn_start")).toHaveLength(2);
    expect(events.some((e) => e.type === "tool_result" && e.name === "echo")).toBe(true);
  });

  it("records an error result when the model calls a tool the agent isn't allowed", async () => {
    const provider = createMockProvider([
      [
        messageStart(),
        ...toolCall("call-1", "bash", { command: "ls" }),
        messageEnd({ inputTokens: 20, outputTokens: 10 }, "tool_use"),
      ],
      // Second turn: model gives up and responds after seeing the error.
      [messageStart(), textDelta("I can't do that."), messageEnd()],
    ]);

    const result = await run({ provider });

    expect(result.stopReason).toBe("done");
    const toolResult = result.messages[2] as ToolResultMessage;
    expect(toolResult.isError).toBe(true);
    expect(toolResult.content).toContain("not available");
  });

  it("stops with 'aborted' when the signal is aborted before the loop starts", async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = createMockProvider([]);

    const result = await run({ provider, signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
    expect(result.turns).toBe(0);
    expect(provider.callCount).toBe(0);
  });

  it("stops with 'aborted' when streaming throws after an external abort", async () => {
    const controller = new AbortController();
    // Provider has no scripts, so stream() throws. We abort right before calling
    // — the loop's catch block normalizes the throw to "aborted".
    const provider = createMockProvider([]);
    controller.abort();

    const result = await run({ provider, signal: controller.signal });

    expect(result.stopReason).toBe("aborted");
  });

  it("stops with 'turn_limit' when maxTurns is reached without a final text turn", async () => {
    // Every turn returns a tool call → loop never sees "done".
    const scripts = Array.from({ length: 3 }, () => [
      messageStart(),
      ...toolCall(`c-${Math.random()}`, "echo", { text: "x" }),
      messageEnd({ inputTokens: 10, outputTokens: 5 }, "tool_use"),
    ]);
    const provider = createMockProvider(scripts);

    const events: AgentEvent[] = [];
    const result = await run({
      provider,
      maxTurns: 3,
      onEvent: (e) => events.push(e),
    });

    expect(result.stopReason).toBe("turn_limit");
    expect(result.turns).toBe(3);
    expect(events.some((e) => e.type === "turn_limit_reached")).toBe(true);
  });

  it("stops with 'error' when streaming throws and there's no abort", async () => {
    // Zero scripts → MockProvider throws. No abort signal → loop reports "error".
    const provider = createMockProvider([]);
    const events: AgentEvent[] = [];

    const result = await run({ provider, onEvent: (e) => events.push(e) });

    expect(result.stopReason).toBe("error");
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("does not mutate the input messages array", async () => {
    const provider = createMockProvider([[messageStart(), textDelta("hi back"), messageEnd()]]);
    const input: Message[] = [userMsg("hi")];
    const before = [...input];

    const result = await run({ provider, messages: input });

    expect(input).toEqual(before);
    expect(result.messages).not.toBe(input);
    expect(result.messages[0]).toEqual(input[0] as Message);
  });

  it("retries once when the model returns an empty stop-terminated turn", async () => {
    // Turn 1 arrives empty with stopReason "stop". The loop silently re-streams,
    // Turn 2 comes back with real content. From the caller's perspective this
    // looks like a single successful turn.
    const provider = createMockProvider([
      [messageStart(), messageEnd({ inputTokens: 10, outputTokens: 0 }, "end_turn")],
      [messageStart(), textDelta("second try"), messageEnd()],
    ]);

    const result = await run({ provider });

    expect(result.stopReason).toBe("done");
    expect(result.turns).toBe(1);
    expect(provider.callCount).toBe(2);
    // Only the successful turn is persisted on the message list.
    expect(result.messages).toHaveLength(2);
    const assistant = result.messages[1] as AssistantMessage;
    expect(assistant.content).toEqual([{ type: "text", text: "second try" }]);
  });

  it("bills usage from a dropped empty retry so /cost matches the provider dashboard", async () => {
    // Empty turn burned 10 input tokens; second (successful) turn burned 12/5.
    // Total should reflect both — we discard the message but not the bill.
    const provider = createMockProvider([
      [messageStart(), messageEnd({ inputTokens: 10, outputTokens: 0 }, "end_turn")],
      [messageStart(), textDelta("ok"), messageEnd({ inputTokens: 12, outputTokens: 5 })],
    ]);

    const result = await run({ provider });

    expect(result.usage.inputTokens).toBe(22);
    expect(result.usage.outputTokens).toBe(5);
  });

  it("skips the empty-response retry when the signal aborts between attempts", async () => {
    // Custom provider that aborts on the way out of the first (empty) stream.
    // With the abort check, the retry is skipped and we report "aborted".
    const controller = new AbortController();
    let calls = 0;
    const provider: Parameters<typeof agentLoop>[0]["provider"] = {
      id: "anthropic",
      async *stream() {
        calls++;
        yield { type: "message_start" };
        yield {
          type: "message_end",
          usage: { inputTokens: 10, outputTokens: 0 },
          stopReason: "end_turn",
        };
        controller.abort();
      },
    };
    const result = await run({ provider, signal: controller.signal });
    expect(calls).toBe(1);
    expect(result.stopReason).toBe("aborted");
  });

  it("gives up after the second empty response", async () => {
    // Both turns empty. We retry once, persist the second empty turn, and
    // fall through to 'done' on zero tool calls.
    const provider = createMockProvider([
      [messageStart(), messageEnd({ inputTokens: 10, outputTokens: 0 }, "end_turn")],
      [messageStart(), messageEnd({ inputTokens: 10, outputTokens: 0 }, "end_turn")],
    ]);

    const result = await run({ provider });

    expect(result.stopReason).toBe("done");
    expect(provider.callCount).toBe(2);
    // The retry's (still-empty) turn is the one that lands on the history.
    expect(result.messages).toHaveLength(2);
    expect((result.messages[1] as AssistantMessage).content).toHaveLength(0);
  });

  it("stops with 'context_limit' after input tokens exceed window - reserve", async () => {
    // haiku has a 200k window and CONTEXT_RESERVE is 20k. Reporting 181k input
    // tokens pushes us past the threshold; next iteration the tracker trips.
    const provider = createMockProvider([
      [
        messageStart(),
        ...toolCall("c1", "echo", { text: "a" }),
        messageEnd({ inputTokens: 181_000, outputTokens: 10 }, "tool_use"),
      ],
    ]);
    const events: AgentEvent[] = [];

    const result = await run({ provider, onEvent: (e) => events.push(e) });

    expect(result.stopReason).toBe("context_limit");
    // Turn 1 ran (producing the huge usage) before turn 2's guard tripped.
    expect(result.turns).toBe(1);
    expect(events.some((e) => e.type === "context_limit_reached")).toBe(true);
  });
});
