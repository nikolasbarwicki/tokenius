import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { checkCommand } from "@/security/command-detection.ts";
import { createPermissionStore } from "@/security/permissions.ts";
import { clearTools, registerTool } from "@/tools/registry.ts";

import {
  executeToolsSequential,
  resolveValidatedPermissions,
  validateToolCalls,
} from "./execute.ts";

import type { ValidatedToolCall } from "./execute.ts";
import type { AgentEvent } from "./types.ts";
import type { PermissionPrompter } from "@/security/permissions.ts";
import type { ToolDefinition } from "@/tools/types.ts";
import type { ToolCallBlock } from "@/types.ts";

// --- Test fixtures ---

const echoTool: ToolDefinition<{ text: string }> = {
  name: "echo",
  description: "Return the input text unchanged.",
  parameters: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  execute: (params) => Promise.resolve({ content: params.text }),
};

// Mimics the real bash tool's interface without spawning a shell — validator
// routes bash args through `checkCommand`, so a stub is enough for loop tests.
const bashStubTool: ToolDefinition<{ command: string }> = {
  name: "bash",
  description: "stubbed bash",
  parameters: {
    type: "object",
    properties: { command: { type: "string" } },
    required: ["command"],
  },
  execute: (params) => Promise.resolve({ content: `ran: ${params.command}` }),
};

const throwingTool: ToolDefinition<Record<string, unknown>> = {
  name: "boom",
  description: "always throws",
  parameters: { type: "object", properties: {} },
  execute: () => {
    throw new Error("kaboom");
  },
};

const hugeOutputTool: ToolDefinition<Record<string, unknown>> = {
  name: "huge",
  description: "emits a lot of lines",
  parameters: { type: "object", properties: {} },
  execute: () =>
    Promise.resolve({
      content: Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n"),
    }),
};

const call = (
  name: string,
  args: Record<string, unknown>,
  id = `call-${name}-${Math.random()}`,
): ToolCallBlock => ({ type: "tool_call", id, name, arguments: args });

const allowPrompter: PermissionPrompter = () => Promise.resolve(["allow"]);
const denyPrompter: PermissionPrompter = () => Promise.resolve(["deny"]);

beforeEach(() => {
  clearTools();
  registerTool(echoTool as unknown as ToolDefinition);
  registerTool(bashStubTool as unknown as ToolDefinition);
  registerTool(throwingTool);
  registerTool(hugeOutputTool);
});

afterEach(() => clearTools());

// --- validateToolCalls ---

describe("validateToolCalls", () => {
  it("flags unknown tools", () => {
    const [v] = validateToolCalls([call("nope", {})]);
    expect(v?.tool).toBeNull();
    expect(v?.error).toContain("Unknown tool: nope");
  });

  it("flags missing required arguments", () => {
    const [v] = validateToolCalls([call("echo", {})]);
    expect(v?.error).toContain("Invalid arguments for echo");
    expect(v?.error).toContain("text");
  });

  it("flags wrong argument types", () => {
    const [v] = validateToolCalls([call("echo", { text: 42 })]);
    expect(v?.error).toContain("must be string");
  });

  it("passes valid calls through with tool attached", () => {
    const [v] = validateToolCalls([call("echo", { text: "hi" })]);
    expect(v?.tool?.name).toBe("echo");
    expect(v?.error).toBeUndefined();
  });

  it("blocks bash commands that match a BLOCKED pattern", () => {
    const [v] = validateToolCalls([call("bash", { command: "rm -rf /" })]);
    expect(v?.error).toContain("bash blocked");
  });

  it("collects a pending permission for bash commands needing confirmation", () => {
    const [v] = validateToolCalls([call("bash", { command: "rm -rf ./build" })]);
    expect(v?.error).toBeUndefined();
    expect(v?.pendingPermission).toBeDefined();
    expect(v?.pendingPermission?.reason).toContain("deletion");
    expect(v?.pendingPermission?.description).toBe("rm -rf ./build");
  });

  it("treats safe bash commands like any other tool", () => {
    const [v] = validateToolCalls([call("bash", { command: "ls -la" })]);
    expect(v?.error).toBeUndefined();
    expect(v?.pendingPermission).toBeUndefined();
  });

  it("rejects tools outside the allowedTools set (agent scoping)", () => {
    const [v] = validateToolCalls([call("echo", { text: "hi" })], ["read", "grep"]);
    expect(v?.tool).toBeNull();
    expect(v?.error).toContain("not available to this agent");
  });

  it("allows tools listed in allowedTools", () => {
    const [v] = validateToolCalls([call("echo", { text: "hi" })], ["echo"]);
    expect(v?.error).toBeUndefined();
    expect(v?.tool?.name).toBe("echo");
  });

  // Parity: the loop-level pre-check and the bash tool's internal check must
  // stay in lockstep. Both route through `checkCommand`, so if these diverge
  // someone added a second detection path — that's the bug this test catches.
  describe.each([
    { command: "ls -la", verdict: "safe" },
    { command: "echo hello", verdict: "safe" },
    { command: "rm -rf /", verdict: "blocked" },
    { command: ":(){ :|:& };:", verdict: "blocked" },
    { command: "rm -rf ./build", verdict: "confirm" },
    { command: "git reset --hard HEAD", verdict: "confirm" },
    { command: "sudo systemctl restart", verdict: "confirm" },
  ])("bash pre-check parity — $command", ({ command, verdict }) => {
    it(`routes through checkCommand and matches verdict "${verdict}"`, () => {
      const detected = checkCommand(command);
      const [v] = validateToolCalls([call("bash", { command })]);

      switch (verdict) {
        case "safe":
          expect(detected.allowed).toBe(true);
          expect(detected.requiresConfirmation).toBe(false);
          expect(v?.error).toBeUndefined();
          expect(v?.pendingPermission).toBeUndefined();
          break;
        case "blocked":
          expect(detected.allowed).toBe(false);
          expect(v?.error).toContain("bash blocked");
          break;
        case "confirm":
          expect(detected.allowed).toBe(true);
          expect(detected.requiresConfirmation).toBe(true);
          expect(v?.error).toBeUndefined();
          expect(v?.pendingPermission?.reason).toBe(detected.reason);
          break;
      }
    });
  });
});

// --- resolveValidatedPermissions ---

describe("resolveValidatedPermissions", () => {
  it("removes pendingPermission when user allows", async () => {
    const store = createPermissionStore();
    const validated = validateToolCalls([call("bash", { command: "rm -rf ./x" })]);
    await resolveValidatedPermissions(validated, allowPrompter, store);
    expect(validated[0]?.pendingPermission).toBeUndefined();
    expect(validated[0]?.error).toBeUndefined();
  });

  it("marks denied calls with an error", async () => {
    const store = createPermissionStore();
    const validated = validateToolCalls([call("bash", { command: "rm -rf ./x" })]);
    await resolveValidatedPermissions(validated, denyPrompter, store);
    expect(validated[0]?.error).toContain("User denied");
    expect(validated[0]?.pendingPermission).toBeUndefined();
  });

  it("does not prompt when no calls have pending permissions", async () => {
    const store = createPermissionStore();
    const validated = validateToolCalls([call("echo", { text: "hi" })]);
    let called = false;
    const prompter: PermissionPrompter = () => {
      called = true;
      return Promise.resolve([]);
    };
    await resolveValidatedPermissions(validated, prompter, store);
    expect(called).toBe(false);
  });

  it("prompts once with all pending calls (batched)", async () => {
    const store = createPermissionStore();
    const validated = validateToolCalls([
      call("echo", { text: "ok" }),
      call("bash", { command: "rm -rf ./a" }),
      call("bash", { command: "git reset --hard" }),
    ]);
    const batches: number[] = [];
    const prompter: PermissionPrompter = (requests) => {
      batches.push(requests.length);
      return Promise.resolve(requests.map(() => "allow" as const));
    };
    await resolveValidatedPermissions(validated, prompter, store);
    expect(batches).toEqual([2]);
  });
});

// --- executeToolsSequential ---

describe("executeToolsSequential", () => {
  const signal = new AbortController().signal;

  it("executes tools in order and returns ToolResultMessages", async () => {
    const validated: ValidatedToolCall[] = validateToolCalls([
      call("echo", { text: "one" }, "c1"),
      call("echo", { text: "two" }, "c2"),
    ]);
    const results = await executeToolsSequential(validated, process.cwd(), signal);
    expect(results).toHaveLength(2);
    expect(results[0]?.content).toBe("one");
    expect(results[0]?.toolCallId).toBe("c1");
    expect(results[1]?.content).toBe("two");
    expect(results[1]?.toolCallId).toBe("c2");
  });

  it("returns an error ToolResultMessage for validation errors without invoking the tool", async () => {
    const validated = validateToolCalls([call("echo", {})]);
    const results = await executeToolsSequential(validated, process.cwd(), signal);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("Invalid arguments");
  });

  it("returns an error ToolResultMessage for denied permissions", async () => {
    const store = createPermissionStore();
    const validated = validateToolCalls([call("bash", { command: "rm -rf ./x" })]);
    await resolveValidatedPermissions(validated, denyPrompter, store);
    const results = await executeToolsSequential(validated, process.cwd(), signal);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("User denied");
  });

  it("wraps thrown errors rather than crashing the loop", async () => {
    const validated = validateToolCalls([call("boom", {})]);
    const results = await executeToolsSequential(validated, process.cwd(), signal);
    expect(results[0]?.isError).toBe(true);
    expect(results[0]?.content).toContain("kaboom");
  });

  it("truncates large output (head direction for non-bash tools)", async () => {
    const validated = validateToolCalls([call("huge", {})]);
    const results = await executeToolsSequential(validated, process.cwd(), signal);
    expect(results[0]?.content.length).toBeLessThan(60_000);
    expect(results[0]?.content).toContain("Output truncated");
    // Head direction keeps the beginning.
    expect(results[0]?.content).toContain("line 0");
    expect(results[0]?.content).not.toContain("line 4999");
  });

  it("emits tool_result events for each call", async () => {
    const events: AgentEvent[] = [];
    const validated = validateToolCalls([call("echo", { text: "hi" }), call("nope", {})]);
    await executeToolsSequential(validated, process.cwd(), signal, (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["tool_result", "tool_result"]);
  });
});
