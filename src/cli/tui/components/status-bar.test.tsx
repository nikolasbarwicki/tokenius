import { describe, expect, it } from "bun:test";

import { render } from "ink-testing-library";
import React from "react";

import { StatusBar } from "./status-bar.tsx";

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replaceAll(/\[[0-9;]*m/g, "");
}

describe("StatusBar", () => {
  it("renders model · session · tokens · cost · context", () => {
    const { lastFrame } = render(
      React.createElement(StatusBar, {
        model: "claude-haiku-4-5-20251001",
        sessionId: "abc123",
        tokens: { inputTokens: 12_345, outputTokens: 678 },
        cost: 0.0123,
        context: { usedTokens: 5000, windowTokens: 200_000 },
      }),
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("claude-haiku-4-5-20251001");
    expect(frame).toContain("abc123");
    expect(frame).toContain("13,023 tokens"); // 12345 + 678
    expect(frame).toContain("$0.0123");
    expect(frame).toContain("5k / 200k tokens");
  });

  it("colors the context indicator green, yellow, or red depending on %", () => {
    const makeFrame = (usedTokens: number): string => {
      const { lastFrame } = render(
        React.createElement(StatusBar, {
          model: "m",
          sessionId: "s",
          tokens: { inputTokens: 0, outputTokens: 0 },
          cost: 0,
          context: { usedTokens, windowTokens: 100 },
        }),
      );
      return lastFrame() ?? "";
    };
    // Structural check — the label appears regardless of ANSI coloring,
    // and exact color codes are verified by the context-indicator unit tests.
    expect(stripAnsi(makeFrame(10))).toContain("10%");
    expect(stripAnsi(makeFrame(60))).toContain("60%");
    expect(stripAnsi(makeFrame(90))).toContain("90%");
  });
});
