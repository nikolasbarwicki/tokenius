// API key resolution. Env vars only — no config-file keys, no keychain
// integration. Keeps `tokenius.json` safe to commit and keeps secrets in
// the usual place (shell env or `.env`, which Bun loads automatically).

import type { ProviderId } from "@/types.ts";

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function resolveApiKey(provider: ProviderId): string {
  const envKey = ENV_KEYS[provider];
  const value = process.env[envKey];
  if (!value) {
    throw new Error(`Missing ${envKey}. Set it in your environment or .env file.`);
  }
  return value;
}
