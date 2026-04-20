import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grepTool, hasRipgrep } from "./grep.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-grep-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.ts"), "const hello = 1\nconst world = 2\n");
  writeFileSync(join(cwd, "src/b.ts"), "function hello() {}\n");
  writeFileSync(join(cwd, "src/c.js"), "const hello_js = 3\n");
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

// Positive-path tests require a real rg binary. Sprint 7.5 adds a pure-JS fallback.
const rgPresent = await hasRipgrep();
const describeIfRg = rgPresent ? describe : describe.skip;

describeIfRg("grep tool (with ripgrep)", () => {
  it("finds matches across files", async () => {
    const r = await grepTool.execute({ pattern: "hello" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).toContain("c.js");
  });

  it("respects include globs", async () => {
    const r = await grepTool.execute({ pattern: "hello", include: "*.ts" }, ctx());
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("c.js");
  });

  it("reports no matches distinctly from an error", async () => {
    const r = await grepTool.execute({ pattern: "zzzzzzzz_not_here" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("no matches");
  });
});

describe("grep tool (always)", () => {
  it("rejects paths outside cwd", async () => {
    const r = await grepTool.execute({ pattern: "x", path: "../" }, ctx());
    expect(r.isError).toBe(true);
  });
});
