import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadAgentsMd } from "./agents-md.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-agents-md-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("loadAgentsMd", () => {
  it("returns null when AGENTS.md is missing", () => {
    expect(loadAgentsMd(cwd)).toBeNull();
  });

  it("returns file contents when AGENTS.md exists", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "Use TypeScript. No any.\n");
    expect(loadAgentsMd(cwd)).toBe("Use TypeScript. No any.\n");
  });

  it("returns empty string for an empty AGENTS.md", () => {
    writeFileSync(join(cwd, "AGENTS.md"), "");
    expect(loadAgentsMd(cwd)).toBe("");
  });
});
