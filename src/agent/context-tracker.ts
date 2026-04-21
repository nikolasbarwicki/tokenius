// Real-token context tracking. No estimation mid-session: after every LLM
// response we snapshot `usage.inputTokens`, which is the authoritative count
// the provider charged us for. `estimateTokens` is only used for the very first
// message (before any response has come back).
//
// We don't compact or summarize; when the tracker reports exhausted, the loop
// stops and surfaces to the user. This keeps the implementation simple and the
// cost model honest — see PLAN Layer 6 design decision.

import { getModelMetadata } from "@/providers/models.ts";

import type { TokenUsage } from "@/types.ts";

/**
 * Headroom reserved for the system prompt, tool schemas, and the model's
 * output. Chosen conservatively — cheaper to stop one turn early than to blow
 * through the window mid-request.
 */
export const CONTEXT_RESERVE = 20_000;

export interface ContextTracker {
  lastKnownInputTokens: number;
  contextWindow: number;
}

export function createContextTracker(model: string): ContextTracker {
  const meta = getModelMetadata(model);
  return { lastKnownInputTokens: 0, contextWindow: meta.contextWindow };
}

export function isContextExhausted(tracker: ContextTracker): boolean {
  return tracker.lastKnownInputTokens > tracker.contextWindow - CONTEXT_RESERVE;
}

export function updateTokenTracking(tracker: ContextTracker, usage: TokenUsage): void {
  tracker.lastKnownInputTokens = usage.inputTokens;
}

/**
 * Rough token estimate for pre-request sizing. ~4 chars/token is a reasonable
 * ballpark for English; bad for code or non-Latin scripts but we only rely on
 * this before the first response comes back.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
