import { describe, expect, test } from "bun:test";

import { getModelMetadata } from "./models.ts";

describe("getModelMetadata", () => {
  test("returns metadata for a known Anthropic model", () => {
    const meta = getModelMetadata("claude-sonnet-4-6");

    expect(meta.id).toBe("claude-sonnet-4-6");
    expect(meta.provider).toBe("anthropic");
    expect(meta.contextWindow).toBe(1_000_000);
    expect(meta.maxOutputTokens).toBe(64_000);
    expect(meta.supportsCaching).toBe(true);
    expect(meta.pricing.input).toBe(3);
    expect(meta.pricing.cacheRead).toBe(0.3);
  });

  test("returns metadata for a known OpenAI model", () => {
    const meta = getModelMetadata("gpt-5.4");

    expect(meta.id).toBe("gpt-5.4");
    expect(meta.provider).toBe("openai");
    expect(meta.contextWindow).toBe(1_000_000);
    expect(meta.supportsCaching).toBe(true);
    expect(meta.pricing.cacheRead).toBe(1.25);
    expect(meta.pricing.cacheWrite).toBeUndefined();
  });

  test("throws for an unknown model", () => {
    expect(() => getModelMetadata("nonexistent-model")).toThrow("Unknown model: nonexistent-model");
  });
});
