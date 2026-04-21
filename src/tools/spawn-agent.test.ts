import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  createMockProvider,
  messageEnd,
  messageStart,
  textDelta,
} from "@/testing/mock-provider.ts";
import { readTool } from "@/tools/read.ts";
import { clearTools, registerTool } from "@/tools/registry.ts";

import { createSpawnAgentTool } from "./spawn-agent.ts";

import type { AgentEvent } from "@/agent/types.ts";
import type { PermissionPrompter } from "@/security/permissions.ts";
import type { ToolDefinition } from "@/tools/types.ts";

const MODEL = "claude-haiku-4-5-20251001";

// Subagents in these tests use read-only tools, so they should never trigger
// a permission prompt. A throwing prompter makes accidental routing loud
// rather than silently downgrading to a deny.
const throwingPrompter: PermissionPrompter = () => {
  throw new Error("prompter should not be called in this test");
};

const ctx = {
  cwd: process.cwd(),
  signal: new AbortController().signal,
  confirm: () => Promise.resolve(true),
};

beforeEach(() => {
  clearTools();
  // Subagents (plan/explore) use read/grep/glob. Register just `read` — that's
  // enough for getToolSchemas to succeed; the subagent script never calls it.
  registerTool(readTool as unknown as ToolDefinition);
});

afterEach(() => {
  clearTools();
});

describe("createSpawnAgentTool", () => {
  it("errors on unknown agent", async () => {
    const provider = createMockProvider([]);
    const tool = createSpawnAgentTool({ provider, model: MODEL, cwd: process.cwd() });

    const result = await tool.execute({ agent: "nope", prompt: "hi" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown subagent");
    expect(provider.callCount).toBe(0);
  });

  it("refuses to spawn the build agent", async () => {
    const provider = createMockProvider([]);
    const tool = createSpawnAgentTool({ provider, model: MODEL, cwd: process.cwd() });

    const result = await tool.execute({ agent: "build", prompt: "hi" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Cannot spawn build agent");
    expect(provider.callCount).toBe(0);
  });

  it("returns the subagent's final assistant text", async () => {
    const provider = createMockProvider([
      [messageStart(), textDelta("Found three files: a, b, c."), messageEnd()],
    ]);
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      prompter: throwingPrompter,
    });

    const result = await tool.execute({ agent: "explore", prompt: "list the files" }, ctx);

    expect(result.isError).toBeUndefined();
    expect(result.content).toBe("Found three files: a, b, c.");
    expect(provider.callCount).toBe(1);
  });

  it("emits subagent_complete with turns, tokens, and cost", async () => {
    const provider = createMockProvider([
      [messageStart(), textDelta("done"), messageEnd({ inputTokens: 100, outputTokens: 50 })],
    ]);
    const events: AgentEvent[] = [];
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      onEvent: (e) => events.push(e),
      prompter: throwingPrompter,
    });

    await tool.execute({ agent: "explore", prompt: "anything" }, ctx);

    const complete = events.find((e) => e.type === "subagent_complete");
    expect(complete).toBeDefined();
    if (complete?.type !== "subagent_complete") {
      throw new Error("expected subagent_complete");
    }
    expect(complete.agent).toBe("explore");
    expect(complete.turns).toBe(1);
    expect(complete.tokens).toBe(150);
    // haiku pricing: 1/M input + 5/M output = 100*1e-6 + 50*5e-6 = 0.000350
    expect(complete.cost).toBeCloseTo(0.00035, 6);
  });

  it("does not forward the subagent's raw events to the parent", async () => {
    // Subagent has two turns of internal activity; the parent should only see
    // one subagent_complete event, never the child's turn_start / text_delta.
    const provider = createMockProvider([[messageStart(), textDelta("working"), messageEnd()]]);
    const events: AgentEvent[] = [];
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      onEvent: (e) => events.push(e),
      prompter: throwingPrompter,
    });

    await tool.execute({ agent: "explore", prompt: "anything" }, ctx);

    expect(events.map((e) => e.type)).toEqual(["subagent_complete"]);
  });

  it("returns an error result when the subagent loop errors", async () => {
    // Zero scripts → MockProvider throws on first stream() call → loop catches
    // and sets stopReason="error".
    const provider = createMockProvider([]);
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      prompter: throwingPrompter,
    });

    const result = await tool.execute({ agent: "explore", prompt: "anything" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("errored");
  });

  it("flags turn_limit as an error so the parent can react", async () => {
    // Every turn returns a tool call → subagent hits maxTurns without ever
    // producing a final text response.
    const script = [
      messageStart(),
      { type: "tool_call_start", id: "c", name: "read" } as const,
      { type: "tool_call_delta", arguments: '{"path":"a.txt"}' } as const,
      { type: "tool_call_end" } as const,
      messageEnd({ inputTokens: 10, outputTokens: 5 }, "tool_use"),
    ];
    // explore agent has maxTurns=10 in AGENTS; provide that many scripts.
    const provider = createMockProvider(Array.from({ length: 10 }, () => [...script]));
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      prompter: throwingPrompter,
    });

    const result = await tool.execute({ agent: "explore", prompt: "anything" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("turn limit");
  });

  it("reports '(subagent produced no response)' when the subagent has no text", async () => {
    // agentLoop retries once on an empty stop-terminated turn (see loop.ts),
    // so script two empty turns — the retry must also come back empty for the
    // subagent to actually surface as "no response".
    const provider = createMockProvider([
      [messageStart(), messageEnd()], // first attempt: empty
      [messageStart(), messageEnd()], // retry: also empty
    ]);
    const tool = createSpawnAgentTool({
      provider,
      model: MODEL,
      cwd: process.cwd(),
      prompter: throwingPrompter,
    });

    const result = await tool.execute({ agent: "explore", prompt: "anything" }, ctx);

    expect(result.content).toBe("(subagent produced no response)");
  });

  it("advertises only non-build agents in its enum", () => {
    const provider = createMockProvider([]);
    const tool = createSpawnAgentTool({ provider, model: MODEL, cwd: process.cwd() });

    const enumValues = tool.parameters.properties.agent as { enum?: readonly string[] };
    expect(enumValues.enum).toBeDefined();
    expect(enumValues.enum).not.toContain("build");
    expect(enumValues.enum).toContain("plan");
    expect(enumValues.enum).toContain("explore");
  });
});
