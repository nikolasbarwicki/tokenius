// Config loader — reads `tokenius.json` from the project root.
//
// Sprint 5 scope: only provider + model. Future sprints will add maxTurns
// overrides and permission rules; we'd rather extend the schema when a
// consumer exists than carry unused fields now.
//
// Fail-fast validation: an invalid config at startup is a bug the user
// should see immediately, not a silent fallback to defaults.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { z } from "zod";

import { getModelMetadata } from "@/providers/models.ts";

import type { ProviderId } from "@/types.ts";

// Strict: unknown keys throw. Typos like `provders` shouldn't silently
// become defaults. Sprint 7 additions (permissions, maxTurns) will extend
// the schema when they're wired up.

export interface TokeniusConfig {
  provider: ProviderId;
  model: string;
  /**
   * Override the provider's API endpoint. Only applies to the `openai` provider
   * — it's how you point at OpenAI-compatible services (xAI, DeepSeek, GLM,
   * Kimi). Ignored for Anthropic (the SDK doesn't expose it and we don't
   * need a use case yet).
   */
  baseUrl?: string;
}

export const DEFAULT_CONFIG: TokeniusConfig = {
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

const ConfigSchema = z
  .object({
    provider: z.enum(["anthropic", "openai"]).optional(),
    model: z.string().optional(),
    baseUrl: z.string().url().optional(),
  })
  .strict();

export function loadConfig(cwd: string): TokeniusConfig {
  const configPath = join(cwd, "tokenius.json");
  if (!existsSync(configPath)) {
    return DEFAULT_CONFIG;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid JSON in tokenius.json: ${(error as Error).message}`, { cause: error });
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path.join(".") || "(root)";
    throw new Error(`Invalid tokenius.json at "${path}": ${issue?.message ?? "unknown error"}`);
  }

  const model = parsed.data.model ?? DEFAULT_CONFIG.model;

  let modelProvider: ProviderId;
  try {
    modelProvider = getModelMetadata(model).provider;
  } catch {
    throw new Error(`Unknown model "${model}" in tokenius.json.`);
  }

  // Only validate when the user explicitly set both fields. When provider
  // is omitted we infer it from the model, which avoids surprising errors
  // that reference a default value the user never wrote.
  if (parsed.data.provider && parsed.data.provider !== modelProvider) {
    throw new Error(
      `Model "${model}" belongs to provider "${modelProvider}", but tokenius.json sets provider to "${parsed.data.provider}".`,
    );
  }

  return {
    provider: modelProvider,
    model,
    ...(parsed.data.baseUrl && { baseUrl: parsed.data.baseUrl }),
  };
}
