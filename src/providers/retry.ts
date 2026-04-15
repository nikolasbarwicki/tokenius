import type { LLMContext, Provider } from "./types.ts";
import type { StreamEvent } from "@/types.ts";

const RETRY_CONFIG = {
  maxRetries: 3,
  baseDelayMs: 1_000,
  retryableStatuses: [429, 500, 502, 503, 529],
};

export async function* streamWithRetry(
  provider: Provider,
  model: string,
  context: LLMContext,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  let lastError = new Error("Stream failed with no attempts");

  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      yield* provider.stream(model, context, signal);
      return;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!isRetryable(error) || attempt === RETRY_CONFIG.maxRetries) {
        break;
      }
      const delay = RETRY_CONFIG.baseDelayMs * 2 ** attempt; // 1s, 2s, 4s
      await Bun.sleep(delay);
    }
  }

  throw lastError;
}

export function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  // Network errors (fetch failures, DNS, timeouts)
  if (error.name === "TypeError" || error.name === "AbortError") {
    return error.name !== "AbortError";
  }

  // HTTP status codes — check for a `status` property (Anthropic and OpenAI SDKs attach this)
  const { status } = error as unknown as Record<string, unknown>;
  if (typeof status === "number") {
    return RETRY_CONFIG.retryableStatuses.includes(status);
  }

  // Connection errors from fetch
  if (error.message.includes("fetch failed") || error.message.includes("ECONNRESET")) {
    return true;
  }

  return false;
}
