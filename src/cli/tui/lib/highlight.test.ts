import { describe, expect, it } from "bun:test";

import { highlightMarkdown } from "./highlight.ts";

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replaceAll(/\[[0-9;]*m/g, "");
}

const FENCE = "```";

describe("highlightMarkdown", () => {
  it("passes plain text through unchanged", () => {
    const out = highlightMarkdown("just some plain prose");
    expect(out).toBe("just some plain prose");
  });

  it("preserves fence markers and content after stripping ANSI", () => {
    const input = `before\n${FENCE}ts\nconst x = 1;\n${FENCE}\nafter`;
    const out = stripAnsi(highlightMarkdown(input));
    expect(out).toBe(input);
  });

  it("preserves code content within a closed code block", () => {
    // Whether ANSI escapes are emitted depends on chalk's TTY detection, so we
    // only assert the content survives round-trip. Visual color is verified
    // manually in the running TUI.
    const input = `${FENCE}ts\nconst x = 1;\n${FENCE}`;
    const out = stripAnsi(highlightMarkdown(input));
    expect(out).toContain("const x = 1;");
  });

  it("leaves an unclosed fence as plain text (streaming mid-fence)", () => {
    const input = `intro\n${FENCE}ts\nconst x = `;
    const out = highlightMarkdown(input);
    expect(out).toBe(input);
  });

  it("handles multiple fences independently", () => {
    const input = `${FENCE}js\n1;\n${FENCE}\nmid\n${FENCE}py\nx = 1\n${FENCE}`;
    const out = stripAnsi(highlightMarkdown(input));
    expect(out).toBe(input);
  });

  it("falls back gracefully for unknown languages", () => {
    const out = stripAnsi(highlightMarkdown(`${FENCE}unknownlang\nfoo\n${FENCE}`));
    expect(out).toContain("foo");
  });
});
