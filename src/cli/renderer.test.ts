// Renderer tests. We buffer writes into an array and assert against the
// concatenated string. ANSI color codes are stripped before matching so
// tests don't break when picocolors updates its escape sequences.

import { describe, expect, it } from "bun:test";

import { createRenderer, formatContextIndicator, previewArgs } from "./renderer.ts";

import type { AgentEvent } from "@/agent/types.ts";

const MODEL = "claude-haiku-4-5-20251001";

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replaceAll(/\u001B\[[0-9;]*m/g, "");
}

function createBuffered(model = MODEL) {
  const chunks: string[] = [];
  const renderer = createRenderer({ model, write: (s) => chunks.push(s) });
  return {
    renderer,
    output: () => stripAnsi(chunks.join("")),
  };
}

function feed(events: readonly AgentEvent[]) {
  const { renderer, output } = createBuffered();
  for (const e of events) {
    renderer.handle(e);
  }
  return output();
}

describe("createRenderer", () => {
  it("streams text_delta straight through", () => {
    const out = feed([
      { type: "text_delta", text: "Hello, " },
      { type: "text_delta", text: "world!" },
    ]);
    expect(out).toBe("Hello, world!");
  });

  it("renders a tool call with args preview and success result", () => {
    const out = feed([
      { type: "tool_call_start", name: "bash", id: "t1" },
      { type: "tool_call_args", name: "bash", partialArgs: '{"command":"echo hi"}' },
      {
        type: "tool_result",
        name: "bash",
        result: { content: "hi\n" },
      },
    ]);
    expect(out).toContain("→ bash");
    expect(out).toContain("echo hi");
    expect(out).toContain("✓");
    expect(out).toContain("3 chars");
  });

  it("renders an error tool result with snippet", () => {
    const out = feed([
      { type: "tool_call_start", name: "read", id: "t1" },
      { type: "tool_call_args", name: "read", partialArgs: '{"path":"/nope"}' },
      {
        type: "tool_result",
        name: "read",
        result: { content: "ENOENT: no such file", isError: true },
      },
    ]);
    expect(out).toContain("→ read");
    expect(out).toContain("/nope");
    expect(out).toContain("✖");
    expect(out).toContain("ENOENT");
  });

  it("pairs sequential tool calls with their results in order", () => {
    const out = feed([
      { type: "tool_call_start", name: "glob", id: "t1" },
      { type: "tool_call_args", name: "glob", partialArgs: '{"pattern":"**/*.ts"}' },
      { type: "tool_call_start", name: "grep", id: "t2" },
      { type: "tool_call_args", name: "grep", partialArgs: '{"pattern":"TODO"}' },
      { type: "tool_result", name: "glob", result: { content: "a.ts\nb.ts" } },
      { type: "tool_result", name: "grep", result: { content: "a.ts:TODO" } },
    ]);

    // glob's preview must appear before grep's preview
    expect(out.indexOf("**/*.ts")).toBeLessThan(out.indexOf("TODO"));
  });

  it("renders the context indicator on turn_end", () => {
    const out = feed([{ type: "turn_end", usage: { inputTokens: 50_000, outputTokens: 100 } }]);
    expect(out).toMatch(/\[\d+k \/ \d+k tokens · \d+%\]/);
  });

  it("emits a friendly message on context_limit_reached", () => {
    const out = feed([{ type: "context_limit_reached" }]);
    expect(out).toContain("context full");
  });
});

describe("previewArgs", () => {
  it("extracts the command for bash", () => {
    expect(previewArgs("bash", '{"command":"ls -la"}')).toBe("ls -la");
  });

  it("collapses multi-line bash commands to first line + marker", () => {
    const preview = previewArgs("bash", '{"command":"echo one\\necho two"}');
    expect(preview).toContain("echo one");
    expect(preview).toContain("⏎");
    expect(preview).not.toContain("echo two");
  });

  it("extracts path for read/write/edit", () => {
    expect(previewArgs("read", '{"path":"src/x.ts"}')).toBe("src/x.ts");
    expect(previewArgs("write", '{"path":"a.md","content":"hi"}')).toBe("a.md");
    expect(previewArgs("edit", '{"path":"b.ts","old_string":"a","new_string":"b"}')).toBe("b.ts");
  });

  it("extracts pattern for grep/glob", () => {
    expect(previewArgs("grep", '{"pattern":"foo"}')).toBe("foo");
    expect(previewArgs("glob", '{"pattern":"**/*.md"}')).toBe("**/*.md");
  });

  it("renders spawn_agent as 'agent: prompt'", () => {
    const preview = previewArgs("spawn_agent", '{"agent":"explore","prompt":"Find auth code"}');
    expect(preview).toBe("explore: Find auth code");
  });

  it("returns '' for malformed/partial JSON", () => {
    expect(previewArgs("bash", '{"command":"echo')).toBe("");
  });

  it("truncates long bash commands", () => {
    const long = "x".repeat(200);
    const preview = previewArgs("bash", `{"command":"${long}"}`);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("formatContextIndicator", () => {
  it("formats usage + window + percentage", () => {
    expect(stripAnsi(formatContextIndicator(1000, 10_000))).toBe("[1k / 10k tokens · 10%]");
    expect(stripAnsi(formatContextIndicator(6000, 10_000))).toBe("[6k / 10k tokens · 60%]");
    expect(stripAnsi(formatContextIndicator(8500, 10_000))).toBe("[9k / 10k tokens · 85%]");
  });

  it("handles zero-size context window without dividing by zero", () => {
    // Defensive: unknown models map to a default window, but if anyone ever
    // passes 0 we shouldn't produce NaN in the percentage.
    expect(stripAnsi(formatContextIndicator(0, 0))).toContain("0%");
  });
});
