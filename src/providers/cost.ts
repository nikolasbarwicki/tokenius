import { getModelMetadata } from "./models.ts";

import type { TokenUsage } from "@/types.ts";

export function calculateCost(model: string, usage: TokenUsage): number {
  const meta = getModelMetadata(model);
  const { pricing } = meta;

  return (
    (usage.inputTokens * pricing.input) / 1_000_000 +
    (usage.outputTokens * pricing.output) / 1_000_000 +
    ((usage.cacheReadTokens ?? 0) * (pricing.cacheRead ?? 0)) / 1_000_000 +
    ((usage.cacheWriteTokens ?? 0) * (pricing.cacheWrite ?? 0)) / 1_000_000
  );
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0),
  };
}
