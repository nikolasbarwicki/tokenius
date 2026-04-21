import { describe, expect, it } from "bun:test";

import { previewArgs } from "./preview.ts";

describe("previewArgs", () => {
  it("extracts the command for bash", () => {
    expect(previewArgs("bash", '{"command":"ls -la"}')).toBe("ls -la");
  });

  it("collapses multi-line bash commands to first line + marker", () => {
    const preview = previewArgs("bash", '{"command":"echo one\\necho two"}');
    expect(preview).toContain("echo one");
    expect(preview).toContain("⏎");
    expect(preview).not.toContain("echo two");
  });

  it("extracts path for read/write/edit", () => {
    expect(previewArgs("read", '{"path":"src/x.ts"}')).toBe("src/x.ts");
    expect(previewArgs("write", '{"path":"a.md","content":"hi"}')).toBe("a.md");
    expect(previewArgs("edit", '{"path":"b.ts","old_string":"a","new_string":"b"}')).toBe("b.ts");
  });

  it("extracts pattern for grep/glob", () => {
    expect(previewArgs("grep", '{"pattern":"foo"}')).toBe("foo");
    expect(previewArgs("glob", '{"pattern":"**/*.md"}')).toBe("**/*.md");
  });

  it("renders spawn_agent as 'agent: prompt'", () => {
    const preview = previewArgs("spawn_agent", '{"agent":"explore","prompt":"Find auth code"}');
    expect(preview).toBe("explore: Find auth code");
  });

  it("returns '' for malformed/partial JSON", () => {
    expect(previewArgs("bash", '{"command":"echo')).toBe("");
  });

  it("truncates long bash commands", () => {
    const long = "x".repeat(200);
    const preview = previewArgs("bash", `{"command":"${long}"}`);
    expect(preview.length).toBeLessThanOrEqual(80);
    expect(preview.endsWith("…")).toBe(true);
  });
});
