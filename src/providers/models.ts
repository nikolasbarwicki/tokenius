import type { ProviderId } from "@/types.ts";

export interface ModelPricing {
  input: number; // Cost per 1M tokens
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ModelMetadata {
  id: string;
  provider: ProviderId;
  contextWindow: number;
  maxOutputTokens: number;
  pricing: ModelPricing;
  supportsCaching: boolean;
}

const MODELS: Record<string, ModelMetadata> = {
  "claude-opus-4-6": {
    id: "claude-opus-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    supportsCaching: true,
  },
  "claude-sonnet-4-6": {
    id: "claude-sonnet-4-6",
    provider: "anthropic",
    contextWindow: 1_000_000,
    maxOutputTokens: 64_000,
    pricing: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    supportsCaching: true,
  },
  "claude-haiku-4-5-20251001": {
    id: "claude-haiku-4-5-20251001",
    provider: "anthropic",
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    pricing: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    supportsCaching: true,
  },
  "gpt-5.4": {
    id: "gpt-5.4",
    provider: "openai",
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    pricing: { input: 2.5, output: 15, cacheRead: 1.25 },
    supportsCaching: true,
  },
  "gpt-5.4-mini": {
    id: "gpt-5.4-mini",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.75, output: 4.5, cacheRead: 0.375 },
    supportsCaching: true,
  },
  "gpt-5.4-nano": {
    id: "gpt-5.4-nano",
    provider: "openai",
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    pricing: { input: 0.2, output: 1.25, cacheRead: 0.1 },
    supportsCaching: true,
  },
};

export function getModelMetadata(model: string): ModelMetadata {
  const meta = MODELS[model];
  if (!meta) {
    throw new Error(`Unknown model: ${model}. Add it to MODELS in models.ts`);
  }
  return meta;
}
