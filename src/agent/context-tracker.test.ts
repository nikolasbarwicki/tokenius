import { describe, expect, it } from "bun:test";

import {
  CONTEXT_RESERVE,
  createContextTracker,
  estimateTokens,
  isContextExhausted,
  updateTokenTracking,
} from "./context-tracker.ts";

describe("createContextTracker", () => {
  it("pulls contextWindow from model metadata", () => {
    // claude-haiku-4-5-20251001 has a 200k window
    const tracker = createContextTracker("claude-haiku-4-5-20251001");
    expect(tracker.contextWindow).toBe(200_000);
    expect(tracker.lastKnownInputTokens).toBe(0);
  });

  it("throws for unknown models (fail-fast)", () => {
    expect(() => createContextTracker("not-a-real-model")).toThrow(/Unknown model/);
  });
});

describe("isContextExhausted", () => {
  it("returns false when well under the reserve", () => {
    const tracker = { lastKnownInputTokens: 50_000, contextWindow: 200_000 };
    expect(isContextExhausted(tracker)).toBe(false);
  });

  it("returns false at exactly window - reserve (boundary is inclusive)", () => {
    const tracker = { lastKnownInputTokens: 200_000 - CONTEXT_RESERVE, contextWindow: 200_000 };
    expect(isContextExhausted(tracker)).toBe(false);
  });

  it("returns true one token past the reserve", () => {
    const tracker = { lastKnownInputTokens: 200_000 - CONTEXT_RESERVE + 1, contextWindow: 200_000 };
    expect(isContextExhausted(tracker)).toBe(true);
  });

  it("returns true when input tokens exceed the window", () => {
    const tracker = { lastKnownInputTokens: 300_000, contextWindow: 200_000 };
    expect(isContextExhausted(tracker)).toBe(true);
  });
});

describe("updateTokenTracking", () => {
  it("overwrites lastKnownInputTokens with the new usage (not additive)", () => {
    const tracker = createContextTracker("claude-haiku-4-5-20251001");
    updateTokenTracking(tracker, { inputTokens: 1000, outputTokens: 200 });
    expect(tracker.lastKnownInputTokens).toBe(1000);
    // The next response reports the full running input — not a delta.
    updateTokenTracking(tracker, { inputTokens: 5000, outputTokens: 400 });
    expect(tracker.lastKnownInputTokens).toBe(5000);
  });

  it("ignores output/cache tokens", () => {
    const tracker = createContextTracker("claude-haiku-4-5-20251001");
    updateTokenTracking(tracker, {
      inputTokens: 100,
      outputTokens: 9999,
      cacheReadTokens: 500,
      cacheWriteTokens: 200,
    });
    expect(tracker.lastKnownInputTokens).toBe(100);
  });
});

describe("estimateTokens", () => {
  it("is zero for the empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("is 1 for very short inputs (rounds up)", () => {
    expect(estimateTokens("a")).toBe(1);
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("is ceil(len / 4)", () => {
    expect(estimateTokens("abcde")).toBe(2);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("abcdefghi")).toBe(3);
  });
});
