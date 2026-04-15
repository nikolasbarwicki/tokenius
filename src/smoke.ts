// Smoke test — hardcoded prompt, stream to stdout.
// Run with: bun run src/smoke.ts
//         bun run src/smoke.ts --debug    (show all stream events)
//
// Requires ANTHROPIC_API_KEY in environment (Bun auto-loads .env).

import pc from "picocolors";

import { createAnthropicProvider } from "@/providers/anthropic.ts";
import { calculateCost } from "@/providers/cost.ts";
import { getModelMetadata } from "@/providers/models.ts";
import { getProvider, registerProvider } from "@/providers/registry.ts";
import { streamWithRetry } from "@/providers/retry.ts";

import type { LLMContext } from "./providers/types.ts";
import type { TokenUsage } from "./types.ts";

const MODEL = "claude-haiku-4-5-20251001";
const args = process.argv.slice(2).filter((a) => a !== "--");
const DEBUG = args.includes("--debug");
const firstPositional = args.find((a) => !a.startsWith("--"));

const apiKey = process.env["ANTHROPIC_API_KEY"];
if (!apiKey) {
  console.error(pc.red("Missing ANTHROPIC_API_KEY. Set it in .env or environment."));
  process.exit(1);
}

// Wire up the provider
const provider = createAnthropicProvider({ apiKey });
registerProvider(provider);

const meta = getModelMetadata(MODEL);
console.log(`${pc.bold("Model:")} ${pc.cyan(meta.id)} ${pc.dim(`(${meta.provider})`)}`);
console.log(`${pc.bold("Context:")} ${pc.cyan(meta.contextWindow.toLocaleString())} tokens`);
console.log(pc.dim("─".repeat(50)));

// Use a prompt that triggers tool_use when tools are provided, plain text otherwise
const prompt = firstPositional ?? "What is a coding agent in 2-3 sentences?";

const context: LLMContext = {
  systemPrompt: "You are a helpful assistant. Be concise.",
  messages: [{ role: "user", content: prompt }],
  tools: [],
  maxTokens: 1024,
};

const anthropic = getProvider("anthropic");
let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
let eventCount = 0;

if (DEBUG) {
  console.log(pc.bold(pc.magenta("\n  DEBUG MODE — showing all stream events\n")));
}

for await (const event of streamWithRetry(anthropic, MODEL, context)) {
  eventCount++;

  if (DEBUG) {
    const tag = pc.dim(`[${String(eventCount).padStart(3)}]`);

    switch (event.type) {
      case "message_start":
        console.log(`${tag} ${pc.bold(pc.blue("▼ message_start"))}`);
        break;
      case "text_delta":
        if (eventCount <= 8) {
          console.log(
            `${tag} ${pc.green("● text_delta")}  ${pc.dim('"')}${event.text}${pc.dim('"')}`,
          );
        } else {
          process.stdout.write(event.text);
        }
        break;
      case "thinking_delta":
        console.log(
          `${tag} ${pc.magenta("◆ thinking")}    ${pc.dim('"')}${event.thinking.slice(0, 60)}${pc.dim('..."')}`,
        );
        break;
      case "tool_call_start":
        console.log(
          `${tag} ${pc.bold(pc.yellow("▶ tool_call"))}   ${pc.yellow(event.name)} ${pc.dim(`id=${event.id}`)}`,
        );
        break;
      case "tool_call_delta":
        console.log(
          `${tag} ${pc.yellow("  ┊ chunk")}     ${pc.dim('"')}${event.arguments}${pc.dim('"')}`,
        );
        break;
      case "tool_call_end":
        console.log(`${tag} ${pc.yellow("  ┗ end")}`);
        break;
      case "message_end": {
        const u = event.usage;
        console.log(
          `\n${tag} ${pc.bold(pc.blue("▲ message_end"))} ${pc.dim(`stop: ${event.stopReason}`)}`,
        );
        console.log(pc.dim("      ┌─────────────────────────────────────"));
        console.log(
          `      │ ${pc.bold("input")}   ${pc.cyan(String(u.inputTokens).padStart(6))} tokens  ${pc.dim("← message_start")}`,
        );
        console.log(
          `      │ ${pc.bold("output")}  ${pc.cyan(String(u.outputTokens).padStart(6))} tokens  ${pc.dim("← message_delta")}`,
        );
        if (u.cacheReadTokens) {
          console.log(
            `      │ ${pc.dim("cache_r")} ${pc.cyan(String(u.cacheReadTokens).padStart(6))} tokens`,
          );
        }
        if (u.cacheWriteTokens) {
          console.log(
            `      │ ${pc.dim("cache_w")} ${pc.cyan(String(u.cacheWriteTokens).padStart(6))} tokens`,
          );
        }
        console.log(pc.dim("      └─────────────────────────────────────"));
        usage = u;
        break;
      }
      case "error":
        console.log(`${tag} ${pc.bold(pc.red("✖ error"))}      ${pc.red(event.error.message)}`);
        break;
    }
  } else {
    // Normal mode — just stream text
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "message_end":
        usage = event.usage;
        break;
    }
  }
}

// Summary
console.log(`\n${pc.dim("─".repeat(50))}`);
console.log(
  `${pc.bold("Tokens:")} ${pc.cyan(String(usage.inputTokens))} in / ${pc.cyan(String(usage.outputTokens))} out`,
);
if (usage.cacheReadTokens || usage.cacheWriteTokens) {
  console.log(
    `${pc.bold("Cache:")}  ${pc.cyan(String(usage.cacheReadTokens ?? 0))} read / ${pc.cyan(String(usage.cacheWriteTokens ?? 0))} write`,
  );
}
console.log(`${pc.bold("Cost:")}   ${pc.green(`$${calculateCost(MODEL, usage).toFixed(6)}`)}`);
if (DEBUG) {
  console.log(`${pc.bold("Events:")} ${pc.cyan(String(eventCount))} total`);
}
