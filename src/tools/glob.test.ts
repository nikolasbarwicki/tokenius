import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { globTool } from "./glob.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-glob-"));
  mkdirSync(join(cwd, "src"));
  mkdirSync(join(cwd, "src/nested"));
  writeFileSync(join(cwd, "src/a.ts"), "");
  writeFileSync(join(cwd, "src/b.ts"), "");
  writeFileSync(join(cwd, "src/nested/c.ts"), "");
  writeFileSync(join(cwd, "src/d.js"), "");
  writeFileSync(join(cwd, "README.md"), "");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("glob tool", () => {
  it("matches a simple pattern", async () => {
    const r = await globTool.execute({ pattern: "src/*.ts" }, ctx());
    const lines = r.content.split("\n");
    expect(lines).toContain("src/a.ts");
    expect(lines).toContain("src/b.ts");
    expect(lines).not.toContain("src/d.js");
  });

  it("matches recursive patterns", async () => {
    const r = await globTool.execute({ pattern: "src/**/*.ts" }, ctx());
    const lines = r.content.split("\n");
    expect(lines).toContain("src/nested/c.ts");
    expect(lines).toContain("src/a.ts");
  });

  it("returns sorted output", async () => {
    const r = await globTool.execute({ pattern: "**/*.ts" }, ctx());
    const lines = r.content.split("\n");
    const sorted = [...lines].toSorted();
    expect(lines).toEqual(sorted);
  });

  it("reports no matches", async () => {
    const r = await globTool.execute({ pattern: "**/*.rb" }, ctx());
    expect(r.content).toContain("no files matched");
  });

  it("rejects base paths outside cwd", async () => {
    const r = await globTool.execute({ pattern: "*", path: "../" }, ctx());
    expect(r.isError).toBe(true);
  });
});
