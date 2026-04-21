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

  throw friendlyProviderError(lastError);
}

/**
 * Turn common provider errors into human-readable messages. Keeps the raw
 * error as `cause` so --debug can still see the underlying stack.
 *
 * We only rewrite the ones a user is likely to hit at boot / mid-session
 * (bad key, wrong model name, oversized prompt, rate-limit fatigue). Anything
 * else passes through unchanged — we'd rather show the SDK's wording than
 * guess and lie.
 */
export function friendlyProviderError(error: Error): Error {
  const status = (error as unknown as Record<string, unknown>)["status"];
  if (typeof status !== "number") {
    return error;
  }

  const wrap = (message: string): Error =>
    Object.assign(new Error(message, { cause: error }), { status });

  switch (status) {
    case 401:
      return wrap("API key rejected (401). Check your ANTHROPIC_API_KEY / OPENAI_API_KEY.");
    case 403:
      return wrap(
        "Access denied (403). The key may lack permission for this model or organization.",
      );
    case 404:
      return wrap(
        `Model not found (404). Check the "model" field in tokenius.json matches a model your key can access.`,
      );
    case 400: {
      // 400 is overloaded — context length is the one worth calling out.
      const msg = error.message.toLowerCase();
      if (msg.includes("context") || msg.includes("too long") || msg.includes("maximum")) {
        return wrap(
          "Request too large (400). The prompt exceeds the model's context window — try /clear to start fresh.",
        );
      }
      return wrap(`Bad request (400): ${error.message}`);
    }
    case 429:
      return wrap("Rate limited (429). Retries exhausted — wait a bit and try again.");
    default:
      return error;
  }
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
