import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeTool } from "./write.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-write-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("write tool", () => {
  it("creates a new file", async () => {
    const r = await writeTool.execute({ path: "foo.txt", content: "hello" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(readFileSync(join(cwd, "foo.txt"), "utf8")).toBe("hello");
  });

  it("overwrites existing files", async () => {
    await writeTool.execute({ path: "foo.txt", content: "a" }, ctx());
    await writeTool.execute({ path: "foo.txt", content: "b" }, ctx());
    expect(readFileSync(join(cwd, "foo.txt"), "utf8")).toBe("b");
  });

  it("creates parent directories (mkdir -p)", async () => {
    const r = await writeTool.execute({ path: "a/b/c/deep.ts", content: "export {}" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(existsSync(join(cwd, "a/b/c/deep.ts"))).toBe(true);
  });

  it("rejects paths outside cwd", async () => {
    const r = await writeTool.execute({ path: "../escape.txt", content: "x" }, ctx());
    expect(r.isError).toBe(true);
    expect(existsSync(join(cwd, "../escape.txt"))).toBe(false);
  });

  it("blocks writing .env", async () => {
    const r = await writeTool.execute({ path: ".env", content: "X=1" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("blocks content containing secrets", async () => {
    const r = await writeTool.execute(
      {
        path: "cfg.ts",
        content: 'export const key = "sk-ant-abcdefghijklmnopqrstuvwxyz12";',
      },
      ctx(),
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("secrets");
    expect(existsSync(join(cwd, "cfg.ts"))).toBe(false);
  });

  it("allows writing clean content", async () => {
    const r = await writeTool.execute(
      { path: "cfg.ts", content: 'export const API_URL = "https://example.com";' },
      ctx(),
    );
    expect(r.isError).toBeUndefined();
  });
});
