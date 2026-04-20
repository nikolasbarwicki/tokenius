import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePath } from "./path-validation.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-path-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("validatePath", () => {
  it("accepts relative paths within cwd", () => {
    const r = validatePath("src/index.ts", cwd);
    expect(r.valid).toBe(true);
    expect(r.resolved.endsWith("src/index.ts")).toBe(true);
  });

  it("accepts absolute paths within cwd", () => {
    const r = validatePath(join(cwd, "foo.txt"), cwd);
    expect(r.valid).toBe(true);
  });

  it("rejects paths escaping cwd via ..", () => {
    const r = validatePath("../escape.txt", cwd);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain("outside the project directory");
  });

  it("rejects absolute paths outside cwd", () => {
    const r = validatePath("/etc/passwd", cwd);
    expect(r.valid).toBe(false);
  });

  it("blocks sensitive filenames", () => {
    for (const name of [".env", ".env.local", "credentials.json", "secrets.json"]) {
      const r = validatePath(name, cwd);
      expect(r.valid).toBe(false);
      expect(r.reason).toContain("blocked");
    }
  });

  it("blocks sensitive subpaths", () => {
    mkdirSync(join(cwd, ".git", "objects"), { recursive: true });
    writeFileSync(join(cwd, ".git", "objects", "pack"), "x");
    const r = validatePath(".git/objects/pack", cwd);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain(".git/objects");
  });

  it("allows writing to new files under cwd (doesn't exist yet)", () => {
    const r = validatePath("nested/new-file.ts", cwd);
    expect(r.valid).toBe(true);
  });

  it("survives macOS /tmp symlink canonicalization", () => {
    // On macOS tmpdir() returns /var/folders/... but /tmp is /private/tmp —
    // the realpath logic should make the startsWith comparison robust.
    const r = validatePath("deep/path.ts", cwd);
    expect(r.valid).toBe(true);
  });
});
