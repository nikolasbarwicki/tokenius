import { describe, expect, it } from "bun:test";

import { formatContextIndicator } from "./context-indicator.ts";

describe("formatContextIndicator", () => {
  it("formats usage + window + percentage", () => {
    expect(formatContextIndicator(1000, 10_000).label).toBe("[1k / 10k tokens · 10%]");
    expect(formatContextIndicator(6000, 10_000).label).toBe("[6k / 10k tokens · 60%]");
    expect(formatContextIndicator(8500, 10_000).label).toBe("[9k / 10k tokens · 85%]");
  });

  it("picks green under 50%, yellow under 80%, red beyond", () => {
    expect(formatContextIndicator(100, 10_000).color).toBe("green");
    expect(formatContextIndicator(6000, 10_000).color).toBe("yellow");
    expect(formatContextIndicator(9000, 10_000).color).toBe("red");
  });

  it("handles zero-size context window without dividing by zero", () => {
    const result = formatContextIndicator(0, 0);
    expect(result.label).toContain("0%");
    expect(result.color).toBe("green");
  });
});
