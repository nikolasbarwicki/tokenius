import { describe, expect, it } from "bun:test";

import {
  createMockProvider,
  messageEnd,
  messageStart,
  textDelta,
} from "@/testing/mock-provider.ts";

import { generateSessionTitle, truncateForTitle } from "./title.ts";

describe("truncateForTitle", () => {
  it("returns short messages unchanged", () => {
    expect(truncateForTitle("Fix auth bug")).toBe("Fix auth bug");
  });

  it("collapses internal whitespace and trims the edges", () => {
    expect(truncateForTitle("  Fix\n  auth\tbug  ")).toBe("Fix auth bug");
  });

  it("clips long messages with an ellipsis", () => {
    const msg = "a".repeat(100);
    const out = truncateForTitle(msg);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns (untitled) for empty or whitespace-only input", () => {
    expect(truncateForTitle("   ")).toBe("(untitled)");
    expect(truncateForTitle("")).toBe("(untitled)");
  });
});

describe("generateSessionTitle", () => {
  it("accumulates text deltas into a title", async () => {
    const provider = createMockProvider([
      [messageStart(), textDelta("Fix "), textDelta("Auth Bug"), messageEnd()],
    ]);
    const title = await generateSessionTitle("please fix the auth bug", provider, "m");
    expect(title).toBe("Fix Auth Bug");
  });

  it("strips surrounding quotes and trailing punctuation", async () => {
    const provider = createMockProvider([
      [messageStart(), textDelta(`"Fix the bug!"`), messageEnd()],
    ]);
    const title = await generateSessionTitle("fix it", provider, "m");
    expect(title).toBe("Fix the bug");
  });

  it("falls back to truncated message when the provider throws", async () => {
    // Mock with no scripts → stream() throws on first call.
    const provider = createMockProvider([]);
    const title = await generateSessionTitle("Add pagination to API", provider, "m");
    expect(title).toBe("Add pagination to API");
  });

  it("falls back to truncated message when the LLM emits only whitespace", async () => {
    const provider = createMockProvider([[messageStart(), textDelta("   "), messageEnd()]]);
    const title = await generateSessionTitle("Summarize readme", provider, "m");
    expect(title).toBe("Summarize readme");
  });

  it("falls back when the stream emits an error event", async () => {
    const provider = createMockProvider([
      [messageStart(), { type: "error", error: new Error("boom") }],
    ]);
    const title = await generateSessionTitle("Refactor cache layer", provider, "m");
    expect(title).toBe("Refactor cache layer");
  });
});
