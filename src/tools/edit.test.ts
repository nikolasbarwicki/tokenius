import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { editTool } from "./edit.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-edit-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

function setFile(name: string, content: string): void {
  writeFileSync(join(cwd, name), content);
}
function readFile(name: string): string {
  return readFileSync(join(cwd, name), "utf8");
}

describe("edit tool", () => {
  it("replaces a unique occurrence", async () => {
    setFile("a.ts", "const x = 1;\nconst y = 2;\n");
    const r = await editTool.execute(
      { path: "a.ts", old_string: "const x = 1;", new_string: "const x = 42;" },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(readFile("a.ts")).toBe("const x = 42;\nconst y = 2;\n");
  });

  it("errors when old_string is not found", async () => {
    setFile("a.ts", "hello");
    const r = await editTool.execute(
      { path: "a.ts", old_string: "missing", new_string: "x" },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
  });

  it("errors when old_string matches multiple times without replace_all", async () => {
    setFile("a.ts", "foo\nfoo\nfoo");
    const r = await editTool.execute({ path: "a.ts", old_string: "foo", new_string: "bar" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("3 times");
    expect(readFile("a.ts")).toBe("foo\nfoo\nfoo");
  });

  it("replaces all occurrences with replace_all", async () => {
    setFile("a.ts", "foo foo foo");
    const r = await editTool.execute(
      { path: "a.ts", old_string: "foo", new_string: "bar", replace_all: true },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
    expect(readFile("a.ts")).toBe("bar bar bar");
    expect(r.content).toContain("3 replacements");
  });

  it("errors on missing file", async () => {
    const r = await editTool.execute({ path: "nope.ts", old_string: "a", new_string: "b" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
  });

  it("errors when old_string === new_string", async () => {
    setFile("a.ts", "x");
    const r = await editTool.execute({ path: "a.ts", old_string: "x", new_string: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("no-op");
  });

  it("errors on empty old_string", async () => {
    setFile("a.ts", "x");
    const r = await editTool.execute({ path: "a.ts", old_string: "", new_string: "y" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("blocks new_string containing secrets", async () => {
    setFile("a.ts", "const key = PLACEHOLDER;");
    const r = await editTool.execute(
      {
        path: "a.ts",
        old_string: "PLACEHOLDER",
        new_string: '"sk-ant-abcdefghijklmnopqrstuvwxyz12"',
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("secrets");
    expect(readFile("a.ts")).toBe("const key = PLACEHOLDER;");
  });

  it("rejects paths outside cwd", async () => {
    const r = await editTool.execute(
      { path: "../outside.ts", old_string: "a", new_string: "b" },
      ctx(),
    );
    expect(r.isError).toBe(true);
  });
});
