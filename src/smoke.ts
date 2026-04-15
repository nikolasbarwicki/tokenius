// Smoke test — hardcoded prompt, stream to stdout.
// Run with: bun run src/smoke.ts
//
// Requires ANTHROPIC_API_KEY in environment (Bun auto-loads .env).

import { createAnthropicProvider } from "@/providers/anthropic.ts";
import { calculateCost } from "@/providers/cost.ts";
import { getModelMetadata } from "@/providers/models.ts";
import { getProvider, registerProvider } from "@/providers/registry.ts";
import { streamWithRetry } from "@/providers/retry.ts";

import type { LLMContext } from "./providers/types.ts";
import type { TokenUsage } from "./types.ts";

const MODEL = "claude-haiku-4-5-20251001";

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error("Missing ANTHROPIC_API_KEY. Set it in .env or environment.");
  process.exit(1);
}

// Wire up the provider
const provider = createAnthropicProvider({ apiKey });
registerProvider(provider);

const meta = getModelMetadata(MODEL);
console.log(`Model: ${meta.id} (${meta.provider})`);
console.log(`Context: ${meta.contextWindow.toLocaleString()} tokens`);
console.log("---");

const context: LLMContext = {
  systemPrompt: "You are a helpful assistant. Be concise.",
  messages: [{ role: "user", content: "What is a coding agent in 2-3 sentences?" }],
  tools: [],
  maxTokens: 1024,
};

const anthropic = getProvider("anthropic");
let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

for await (const event of streamWithRetry(anthropic, MODEL, context)) {
  switch (event.type) {
    case "text_delta":
      process.stdout.write(event.text);
      break;
    case "message_end":
      usage = event.usage;
      break;
  }
}

console.log("\n---");
console.log(`Tokens: ${usage.inputTokens} in / ${usage.outputTokens} out`);
console.log(`Cost: $${calculateCost(MODEL, usage).toFixed(6)}`);
