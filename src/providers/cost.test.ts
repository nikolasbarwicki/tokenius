import { describe, expect, test } from "bun:test";

import { addUsage, calculateCost } from "./cost.ts";

import type { TokenUsage } from "@/types.ts";

describe("calculateCost", () => {
  test("calculates cost for Anthropic model with cache tokens", () => {
    const usage: TokenUsage = {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
    };

    // claude-sonnet-4-6: input=3, output=15, cacheRead=0.3, cacheWrite=3.75
    const cost = calculateCost("claude-sonnet-4-6", usage);
    expect(cost).toBeCloseTo(3 + 15 + 0.3 + 3.75);
  });

  test("calculates cost without cache tokens", () => {
    const usage: TokenUsage = {
      inputTokens: 500_000,
      outputTokens: 100_000,
    };

    // gpt-5.4: input=2.5, output=15
    const cost = calculateCost("gpt-5.4", usage);
    expect(cost).toBeCloseTo(2.5 * 0.5 + 15 * 0.1);
  });

  test("returns zero for zero usage", () => {
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    expect(calculateCost("gpt-5.4-mini", usage)).toBe(0);
  });

  test("throws for unknown model", () => {
    const usage: TokenUsage = { inputTokens: 100, outputTokens: 100 };
    expect(() => calculateCost("unknown-model", usage)).toThrow("Unknown model");
  });
});

describe("addUsage", () => {
  test("adds two usages together", () => {
    const a: TokenUsage = {
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
    };
    const b: TokenUsage = {
      inputTokens: 300,
      outputTokens: 400,
      cacheReadTokens: 25,
      cacheWriteTokens: 5,
    };

    const result = addUsage(a, b);
    expect(result).toEqual({
      inputTokens: 400,
      outputTokens: 600,
      cacheReadTokens: 75,
      cacheWriteTokens: 15,
    });
  });

  test("handles missing cache fields", () => {
    const a: TokenUsage = { inputTokens: 100, outputTokens: 200 };
    const b: TokenUsage = { inputTokens: 50, outputTokens: 50, cacheReadTokens: 10 };

    const result = addUsage(a, b);
    expect(result).toEqual({
      inputTokens: 150,
      outputTokens: 250,
      cacheReadTokens: 10,
      cacheWriteTokens: 0,
    });
  });
});
