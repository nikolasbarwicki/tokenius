// Session title generation.
//
// After the first turn completes, ask the same provider/model that ran the
// turn to summarize the first user message as a 3-5 word title. This is a
// small, best-effort call — if it fails for any reason (network, abort,
// empty response) we fall back to a truncated version of the message itself.
// No error is ever surfaced to the caller.
//
// Reusing the session's model keeps the code dependency-graph small. A
// cheap-model router is a future optimization (Sprint 7+); at ~20 output
// tokens the cost is already negligible.

import type { Provider } from "@/providers/types.ts";

const SYSTEM_PROMPT =
  "Summarize the user's request as a short session title (3-5 words). " +
  "Respond with plain text only: no quotes, no trailing punctuation, Title Case.";

const MAX_TOKENS = 24;
const FALLBACK_MAX_CHARS = 40;
// Hard cap so a hung provider can't block the post-turn flow. Combined with
// any caller-supplied signal via AbortSignal.any.
const TITLE_TIMEOUT_MS = 10_000;

/**
 * Derive a title from the first user message. Collapses whitespace and
 * clips to a readable length. Always returns a non-empty string.
 */
export function truncateForTitle(message: string): string {
  const clean = message.replaceAll(/\s+/g, " ").trim();
  if (clean.length === 0) {
    return "(untitled)";
  }
  if (clean.length <= FALLBACK_MAX_CHARS) {
    return clean;
  }
  return `${clean.slice(0, FALLBACK_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Ask the provider to summarize the first user message. Falls back to a
 * truncated form of the message on any failure.
 */
export async function generateSessionTitle(
  firstUserMessage: string,
  provider: Provider,
  model: string,
  signal?: AbortSignal,
): Promise<string> {
  const timeoutSignal = AbortSignal.timeout(TITLE_TIMEOUT_MS);
  const effectiveSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

  try {
    let text = "";
    for await (const event of provider.stream(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [{ role: "user", content: firstUserMessage }],
        tools: [],
        maxTokens: MAX_TOKENS,
      },
      effectiveSignal,
    )) {
      if (event.type === "text_delta") {
        text += event.text;
      } else if (event.type === "error") {
        throw event.error;
      }
    }

    const title = sanitizeTitle(text);
    return title.length > 0 ? title : truncateForTitle(firstUserMessage);
  } catch {
    return truncateForTitle(firstUserMessage);
  }
}

function sanitizeTitle(raw: string): string {
  return raw
    .trim()
    .replaceAll(/^["'`]+|["'`]+$/g, "")
    .replaceAll(/[.!?]+$/g, "")
    .trim();
}
