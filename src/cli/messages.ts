// CLI chrome — startup banner, first-run hint, friendly missing-key block.
// Write-only, keeps index.ts focused on wiring.

import pc from "picocolors";

import { isDebugEnabled } from "@/debug.ts";
import { getModelMetadata } from "@/providers/models.ts";

import type { MissingApiKeyError } from "@/config/api-keys.ts";

const BAR = pc.dim("─".repeat(50));

const KEY_URLS: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};

export function printBanner(
  cwd: string,
  providerId: string,
  model: string,
  sessionId: string,
): void {
  const meta = getModelMetadata(model);
  console.log(BAR);
  console.log(`${pc.bold("tokenius")}  ${pc.dim(`session ${sessionId}`)}`);
  console.log(
    `${pc.dim("provider:")} ${pc.cyan(providerId)}  ${pc.dim("model:")} ${pc.cyan(model)}  ${pc.dim(`(${meta.contextWindow.toLocaleString()} ctx)`)}`,
  );
  console.log(`${pc.dim("cwd:")} ${cwd}`);
  if (isDebugEnabled()) {
    console.log(pc.magenta("debug mode on — raw events → stderr"));
  }
  console.log(BAR);
  console.log(pc.dim("Type /help for commands, /quit to exit.\n"));
}

export function printFirstRunHint(cwd: string): void {
  console.log(
    pc.yellow(
      `\n[hint] Created .tokenius/sessions/ in this project for the first time.\n       Consider adding ".tokenius/" to ${cwd}/.gitignore so session files aren't committed.\n`,
    ),
  );
}

export function printMissingApiKey(error: MissingApiKeyError): void {
  const url = KEY_URLS[error.provider] ?? "";

  console.error(pc.red(pc.bold(`\nMissing API key: ${error.envVar}\n`)));
  console.error(`tokenius is configured to use ${pc.cyan(error.provider)} but the`);
  console.error(`${pc.bold(error.envVar)} environment variable isn't set.`);
  console.error("");
  console.error(pc.bold("Get a key:"));
  if (url) {
    console.error(`  ${url}`);
  }
  console.error("");
  console.error(pc.bold("Then set it — either:"));
  console.error(`  ${pc.dim("# in a .env file at the project root (Bun auto-loads this)")}`);
  console.error(`  ${pc.cyan(`${error.envVar}=sk-...`)}`);
  console.error("");
  console.error(`  ${pc.dim("# or export it in your shell")}`);
  console.error(`  ${pc.cyan(`export ${error.envVar}=sk-...`)}`);
  console.error(BAR);
}
