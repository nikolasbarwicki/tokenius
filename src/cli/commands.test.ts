// Dispatch-level tests for slash commands. We exercise the router (correct
// command gets called, unknown names surface an error) and a few end-to-end
// flows that require disk state (/sessions, /load, /clear).
//
// `/cost` is tested against a hand-crafted session with known usage so the
// math stays stable even if pricing changes.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendMessage, createSession } from "@/session/manager.ts";

import { executeCommand, parseCommand } from "./commands.ts";

import type { CommandContext } from "./commands.ts";
import type { AssistantMessage, Message } from "@/types.ts";

const MODEL = "claude-haiku-4-5-20251001";

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

function makeCtx(cwd: string) {
  const chunks: string[] = [];
  const { session } = createSession(cwd, MODEL);
  const ctx: CommandContext = {
    session,
    cwd,
    write: (s) => chunks.push(s),
  };
  return { ctx, output: () => stripAnsi(chunks.join("")) };
}

let tempCwd: string;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), "tokenius-cmd-"));
});

afterEach(() => {
  rmSync(tempCwd, { recursive: true, force: true });
});

describe("parseCommand", () => {
  it("parses a bare command", () => {
    expect(parseCommand("/help")).toEqual({ name: "/help", arg: "" });
  });

  it("parses a command with an argument", () => {
    expect(parseCommand("/load abc-123")).toEqual({ name: "/load", arg: "abc-123" });
  });

  it("returns null for non-slash input", () => {
    expect(parseCommand("hello")).toBeNull();
  });

  it("returns null for skill invocation prefix so the REPL handles it", () => {
    expect(parseCommand("/skill:summarize this thing")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(parseCommand("  /cost  ")).toEqual({ name: "/cost", arg: "" });
  });
});

describe("executeCommand — dispatch", () => {
  it("returns exit for /quit and /exit", async () => {
    const { ctx } = makeCtx(tempCwd);
    const quit = await executeCommand("/quit", ctx);
    expect(quit.type).toBe("exit");
    const exit = await executeCommand("/exit", ctx);
    expect(exit.type).toBe("exit");
  });

  it("returns unknown for an unknown command and prints suggestions", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    const result = await executeCommand("/nonsense", ctx);
    expect(result).toEqual({ type: "unknown", name: "/nonsense" });
    expect(output()).toContain("Unknown command");
    expect(output()).toContain("/help");
  });

  it("returns none for non-slash input (not a command)", async () => {
    const { ctx } = makeCtx(tempCwd);
    const result = await executeCommand("hello world", ctx);
    expect(result.type).toBe("none");
  });

  it("/help lists the available commands", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    await executeCommand("/help", ctx);
    const text = output();
    for (const c of [
      "/help",
      "/quit",
      "/sessions",
      "/load",
      "/cost",
      "/usage",
      "/clear",
      "/skills",
    ]) {
      expect(text).toContain(c);
    }
  });
});

describe("executeCommand — /sessions and /load", () => {
  it("/sessions reports emptiness when no other sessions exist", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    await executeCommand("/sessions", ctx);
    // The current session IS listed (it was created in makeCtx), so this
    // output is never completely empty — we assert it at least mentions the
    // session id header row.
    expect(output()).toContain(ctx.session.id);
  });

  it("/load replaces the active session", async () => {
    // Create another session to load
    const other = createSession(tempCwd, MODEL).session;
    appendMessage(tempCwd, other.id, { role: "user", content: "from the past" });

    const { ctx } = makeCtx(tempCwd);
    const result = await executeCommand(`/load ${other.id}`, ctx);
    expect(result.type).toBe("replace_session");
    if (result.type === "replace_session") {
      expect(result.session.id).toBe(other.id);
      expect(result.session.messages).toHaveLength(1);
    }
  });

  it("/load complains when the id doesn't exist", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    const result = await executeCommand("/load nope-nope", ctx);
    expect(result.type).toBe("none");
    expect(output()).toContain("not found");
  });

  it("/load without an id prints usage", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    const result = await executeCommand("/load", ctx);
    expect(result.type).toBe("none");
    expect(output()).toContain("Usage:");
  });
});

describe("executeCommand — /clear", () => {
  it("returns replace_session with a fresh id and empty messages", async () => {
    const { ctx } = makeCtx(tempCwd);
    const originalId = ctx.session.id;
    const result = await executeCommand("/clear", ctx);

    expect(result.type).toBe("replace_session");
    if (result.type === "replace_session") {
      expect(result.session.id).not.toBe(originalId);
      expect(result.session.messages).toHaveLength(0);
      expect(result.session.header.model).toBe(MODEL);
    }
  });
});

describe("executeCommand — /cost", () => {
  it("sums token usage across assistant messages", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    const msg1: AssistantMessage = {
      role: "assistant",
      content: [
        { type: "text", text: "sure" },
        { type: "tool_call", id: "t1", name: "bash", arguments: { command: "ls" } },
      ],
      usage: { inputTokens: 1000, outputTokens: 200 },
      stopReason: "tool_use",
    };
    const msg2: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { inputTokens: 1500, outputTokens: 50 },
      stopReason: "stop",
    };
    ctx.session.messages.push(msg1 as Message, msg2 as Message);

    await executeCommand("/cost", ctx);
    const text = output();
    expect(text).toContain("Session cost");
    expect(text).toContain("2 (1 tool calls)");
    // 1000 + 1500 = 2500 input tokens
    expect(text).toContain("2,500");
  });
});

describe("executeCommand — /usage", () => {
  it("includes session id, model, turns, tokens, cost, and context %", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    ctx.session.header.title = "A test title";
    const msg: AssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { inputTokens: 2000, outputTokens: 100 },
      stopReason: "stop",
    };
    ctx.session.messages.push(msg as Message);

    await executeCommand("/usage", ctx);
    const text = output();
    expect(text).toContain("Session usage");
    expect(text).toContain(ctx.session.id);
    expect(text).toContain("A test title");
    expect(text).toContain(MODEL);
    expect(text).toContain("Context:");
    // haiku has a 200k window; 2000 / 200_000 = 1%
    expect(text).toContain("1%");
  });

  it("renders cleanly with no assistant messages", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    await executeCommand("/usage", ctx);
    const text = output();
    expect(text).toContain("Session usage");
    expect(text).toContain("0 (0 tool calls)");
    expect(text).toContain("0%");
  });
});

describe("executeCommand — /skills", () => {
  it("reports 'no skills' when the directory is missing", async () => {
    const { ctx, output } = makeCtx(tempCwd);
    await executeCommand("/skills", ctx);
    expect(output()).toContain("No skills");
  });

  it("lists discovered skills", async () => {
    const skillDir = join(tempCwd, ".tokenius", "skills", "summarize");
    mkdirSync(skillDir, { recursive: true });
    const content =
      "---\ndescription: Summarize a thing\n---\n# Summarize\n\nDo the summarizing.\n";
    await Bun.write(join(skillDir, "SKILL.md"), content);

    const { ctx, output } = makeCtx(tempCwd);
    await executeCommand("/skills", ctx);
    const text = output();
    expect(text).toContain("/skill:summarize");
    expect(text).toContain("Summarize a thing");
  });
});
