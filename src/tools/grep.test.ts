import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { grepTool, hasRipgrep, resetRipgrepCache } from "./grep.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-grep-"));
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src/a.ts"), "const hello = 1\nconst world = 2\n");
  writeFileSync(join(cwd, "src/b.ts"), "function hello() {}\n");
  writeFileSync(join(cwd, "src/c.js"), "const hello_js = 3\n");
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  resetRipgrepCache();
});

// Positive-path tests via the rg binary only run when it's installed; the
// pure-JS fallback below runs everywhere.
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

// Force the fallback by stashing PATH so `rg` lookups fail. Runs on every
// machine regardless of whether rg is installed.
describe("grep tool (pure-JS fallback)", () => {
  let originalPath: string | undefined;

  beforeEach(() => {
    resetRipgrepCache();
    originalPath = process.env["PATH"];
    process.env["PATH"] = "/nowhere";
  });

  afterEach(() => {
    if (originalPath === undefined) {
      delete process.env["PATH"];
    } else {
      process.env["PATH"] = originalPath;
    }
    resetRipgrepCache();
  });

  it("finds matches across files", async () => {
    const r = await grepTool.execute({ pattern: "hello" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).toContain("c.js");
  });

  it("emits path:line:match lines", async () => {
    const r = await grepTool.execute({ pattern: "world" }, ctx());
    expect(r.content).toMatch(/a\.ts:2:const world = 2/);
  });

  it("respects include globs", async () => {
    const r = await grepTool.execute({ pattern: "hello", include: "**/*.ts" }, ctx());
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toContain("c.js");
  });

  it("files_only returns just paths without line numbers", async () => {
    const r = await grepTool.execute({ pattern: "hello", files_only: true }, ctx());
    expect(r.content).toContain("a.ts");
    expect(r.content).toContain("b.ts");
    expect(r.content).not.toMatch(/a\.ts:\d/);
  });

  it("ignore_case matches mixed case", async () => {
    writeFileSync(join(cwd, "src/d.ts"), "HELLO WORLD\n");
    const r = await grepTool.execute({ pattern: "hello", ignore_case: true }, ctx());
    expect(r.content).toContain("d.ts");
  });

  it("reports no matches distinctly from an error", async () => {
    const r = await grepTool.execute({ pattern: "zzzzzzzz_not_here" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("no matches");
  });

  it("skips node_modules and .git", async () => {
    mkdirSync(join(cwd, "node_modules/fake"), { recursive: true });
    writeFileSync(join(cwd, "node_modules/fake/x.ts"), "const hello = 42\n");
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git/config"), "hello\n");

    const r = await grepTool.execute({ pattern: "hello" }, ctx());
    expect(r.content).not.toContain("node_modules");
    expect(r.content).not.toContain(".git");
  });

  it("surfaces invalid regex as an error", async () => {
    const r = await grepTool.execute({ pattern: "(" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("invalid regex");
  });
});

describe("grep tool (always)", () => {
  it("rejects paths outside cwd", async () => {
    const r = await grepTool.execute({ pattern: "x", path: "../" }, ctx());
    expect(r.isError).toBe(true);
  });
});
