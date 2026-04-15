import { describe, expect, test } from "bun:test";

import { isRetryable } from "./retry.ts";

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
