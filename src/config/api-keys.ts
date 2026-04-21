// API key resolution. Env vars only — no config-file keys, no keychain
// integration. Keeps `tokenius.json` safe to commit and keeps secrets in
// the usual place (shell env or `.env`, which Bun loads automatically).

import type { ProviderId } from "@/types.ts";

const ENV_KEYS: Record<ProviderId, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Thrown when the configured provider's env var isn't set. The CLI catches
 * this by type and renders a friendlier, actionable message — we don't want
 * a bare `Error: Missing X` for what is the single most common first-run
 * failure mode.
 */
export class MissingApiKeyError extends Error {
  readonly provider: ProviderId;
  readonly envVar: string;

  constructor(provider: ProviderId, envVar: string) {
    super(`Missing ${envVar}. Set it in your environment or .env file.`);
    this.name = "MissingApiKeyError";
    this.provider = provider;
    this.envVar = envVar;
  }
}

export function resolveApiKey(provider: ProviderId): string {
  const envKey = ENV_KEYS[provider];
  const value = process.env[envKey];
  if (!value) {
    throw new MissingApiKeyError(provider, envKey);
  }
  return value;
}
