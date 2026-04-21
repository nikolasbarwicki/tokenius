import { describe, expect, test } from "bun:test";

import { friendlyProviderError, isRetryable } from "./retry.ts";

const withStatus = (status: number, message = "raw sdk message"): Error =>
  Object.assign(new Error(message), { status });

describe("isRetryable", () => {
  test("returns true for rate limit (429)", () => {
    const error = Object.assign(new Error("Rate limited"), { status: 429 });
    expect(isRetryable(error)).toBe(true);
  });

  test("returns true for server errors (500, 502, 503, 529)", () => {
    for (const status of [500, 502, 503, 529]) {
      const error = Object.assign(new Error("Server error"), { status });
      expect(isRetryable(error)).toBe(true);
    }
  });

  test("returns false for client errors (400, 401, 403, 404)", () => {
    for (const status of [400, 401, 403, 404]) {
      const error = Object.assign(new Error("Client error"), { status });
      expect(isRetryable(error)).toBe(false);
    }
  });

  test("returns true for network errors (TypeError)", () => {
    const error = new TypeError("fetch failed");
    expect(isRetryable(error)).toBe(true);
  });

  test("returns false for AbortError", () => {
    const error = new DOMException("Aborted", "AbortError");
    expect(isRetryable(error)).toBe(false);
  });

  test("returns true for connection reset", () => {
    const error = new Error("ECONNRESET");
    expect(isRetryable(error)).toBe(true);
  });

  test("returns true for fetch failed message", () => {
    const error = new Error("fetch failed");
    expect(isRetryable(error)).toBe(true);
  });

  test("returns false for non-Error values", () => {
    expect(isRetryable("string error")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    // eslint-disable-next-line unicorn/no-useless-undefined -- testing explicit undefined input
    expect(isRetryable(undefined)).toBe(false);
  });

  test("returns false for generic errors without status", () => {
    const error = new Error("Something went wrong");
    expect(isRetryable(error)).toBe(false);
  });
});

describe("friendlyProviderError", () => {
  test("rewrites 401 to mention the API key", () => {
    const rewritten = friendlyProviderError(withStatus(401));
    expect(rewritten.message).toContain("401");
    expect(rewritten.message).toMatch(/API key/i);
  });

  test("rewrites 403 to mention permission", () => {
    expect(friendlyProviderError(withStatus(403)).message).toMatch(/permission|denied/i);
  });

  test("rewrites 404 to mention tokenius.json", () => {
    expect(friendlyProviderError(withStatus(404)).message).toContain("tokenius.json");
  });

  test("rewrites 400 context-length errors with a /clear hint", () => {
    const raw = withStatus(400, "prompt is too long: 205000 tokens > 200000 maximum");
    const rewritten = friendlyProviderError(raw);
    expect(rewritten.message).toMatch(/context window|too large/i);
    expect(rewritten.message).toContain("/clear");
  });

  test("passes 400 through with context when it's not a length error", () => {
    const raw = withStatus(400, "invalid 'messages' shape");
    const rewritten = friendlyProviderError(raw);
    expect(rewritten.message).toContain("400");
    expect(rewritten.message).toContain("invalid 'messages' shape");
  });

  test("preserves the original error as `cause`", () => {
    const raw = withStatus(401);
    const rewritten = friendlyProviderError(raw);
    expect(rewritten.cause).toBe(raw);
  });

  test("passes through errors without a numeric status", () => {
    const raw = new Error("network blew up");
    expect(friendlyProviderError(raw)).toBe(raw);
  });

  test("passes through unrecognized status codes unchanged", () => {
    const raw = withStatus(418, "I'm a teapot");
    expect(friendlyProviderError(raw)).toBe(raw);
  });
});
