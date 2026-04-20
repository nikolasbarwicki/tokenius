import { describe, expect, it } from "bun:test";

import { MAX_BYTES, MAX_LINES, truncateHead, truncateTail } from "./truncation.ts";

describe("truncateHead", () => {
  it("returns content unchanged when under limits", () => {
    const input = "line1\nline2\nline3";
    const result = truncateHead(input);
    expect(result.wasTruncated).toBe(false);
    expect(result.content).toBe(input);
    expect(result.originalLines).toBe(3);
  });

  it("handles empty input", () => {
    const result = truncateHead("");
    expect(result.wasTruncated).toBe(false);
    expect(result.content).toBe("");
    expect(result.originalLines).toBe(0);
  });

  it("truncates to MAX_LINES and appends notice", () => {
    const input = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line${i}`).join("\n");
    const result = truncateHead(input);
    expect(result.wasTruncated).toBe(true);
    expect(result.originalLines).toBe(MAX_LINES + 500);
    expect(result.content).toContain("[Output truncated:");
    expect(result.content).toContain(`of ${MAX_LINES + 500} lines`);
  });

  it("truncates to MAX_BYTES and never cuts mid-line", () => {
    // Build a long input where each line is small enough that byte-cutting
    // would land mid-line if we didn't snap to a newline.
    const line = "x".repeat(100);
    const input = Array.from({ length: 1000 }, () => line).join("\n");
    const result = truncateHead(input);

    expect(result.wasTruncated).toBe(true);
    const payload = result.content.split("\n\n[Output truncated:")[0] ?? "";
    // Every kept line should be the full original line (no mid-line cut).
    for (const l of payload.split("\n")) {
      if (l.length > 0) {
        expect(l).toBe(line);
      }
    }
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });
});

describe("truncateTail", () => {
  it("returns content unchanged when under limits", () => {
    const input = "line1\nline2\nline3";
    const result = truncateTail(input);
    expect(result.wasTruncated).toBe(false);
    expect(result.content).toBe(input);
  });

  it("keeps the end of the output with notice at the top", () => {
    const input = Array.from({ length: MAX_LINES + 500 }, (_, i) => `line${i}`).join("\n");
    const result = truncateTail(input);
    expect(result.wasTruncated).toBe(true);
    expect(result.content.startsWith("[Output truncated:")).toBe(true);
    // The final line of the input must be present — tail keeps the end.
    expect(result.content.endsWith(`line${MAX_LINES + 499}`)).toBe(true);
  });

  it("never cuts mid-line when byte-limited", () => {
    const line = "y".repeat(100);
    const input = Array.from({ length: 1000 }, () => line).join("\n");
    const result = truncateTail(input);

    expect(result.wasTruncated).toBe(true);
    const payload = result.content.split("\n\n").slice(1).join("\n\n");
    for (const l of payload.split("\n")) {
      if (l.length > 0) {
        expect(l).toBe(line);
      }
    }
    expect(Buffer.byteLength(payload, "utf8")).toBeLessThanOrEqual(MAX_BYTES);
  });
});
