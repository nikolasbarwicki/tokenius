import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readTool } from "./read.ts";

let cwd: string;
const ctx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-read-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("read tool", () => {
  it("reads a file with 1-based line numbers", async () => {
    writeFileSync(join(cwd, "a.txt"), "alpha\nbeta\ngamma");
    const r = await readTool.execute({ path: "a.txt" }, ctx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("     1\talpha");
    expect(r.content).toContain("     2\tbeta");
    expect(r.content).toContain("     3\tgamma");
  });

  it("applies offset and limit", async () => {
    writeFileSync(join(cwd, "a.txt"), ["a", "b", "c", "d", "e"].join("\n"));
    const r = await readTool.execute({ path: "a.txt", offset: 2, limit: 2 }, ctx());
    expect(r.content).toContain("     2\tb");
    expect(r.content).toContain("     3\tc");
    expect(r.content).not.toContain("     4\td");
  });

  it("detects binary files without reading all content", async () => {
    writeFileSync(join(cwd, "bin"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    const r = await readTool.execute({ path: "bin" }, ctx());
    expect(r.content).toContain("(binary file");
  });

  it("rejects paths outside cwd", async () => {
    const r = await readTool.execute({ path: "../escape.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("blocked");
  });

  it("rejects blocked filenames (.env)", async () => {
    writeFileSync(join(cwd, ".env"), "SECRET=1");
    const r = await readTool.execute({ path: ".env" }, ctx());
    expect(r.isError).toBe(true);
  });

  it("errors on missing file", async () => {
    const r = await readTool.execute({ path: "nope.txt" }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("not found");
  });

  it("errors on directory", async () => {
    const r = await readTool.execute({ path: "." }, ctx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("directory");
  });
});
