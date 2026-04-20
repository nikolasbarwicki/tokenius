import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { bashTool } from "./bash.ts";

import type { ConfirmRequest } from "./types.ts";

let cwd: string;
const baseCtx = () => ({ cwd, signal: new AbortController().signal });

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-bash-"));
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("bash tool", () => {
  it("executes a simple command", async () => {
    const r = await bashTool.execute({ command: "echo hello" }, baseCtx());
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("hello");
  });

  it("captures stderr alongside stdout", async () => {
    const r = await bashTool.execute({ command: "echo out; echo err 1>&2" }, baseCtx());
    expect(r.content).toContain("out");
    expect(r.content).toContain("err");
  });

  it("reports non-zero exit codes", async () => {
    const r = await bashTool.execute({ command: "exit 7" }, baseCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("exit 7");
  });

  it("runs in the provided cwd", async () => {
    const r = await bashTool.execute({ command: "pwd" }, baseCtx());
    // cwd is realpath-ish on macOS; just check the content matches either form
    expect(r.content.trim().endsWith(cwd.split("/").pop() ?? "")).toBe(true);
  });

  it("blocks unsafe commands outright", async () => {
    const r = await bashTool.execute({ command: "rm -rf /" }, baseCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("blocked");
  });

  it("requires confirmation for destructive commands and denies when hook says no", async () => {
    const prompts: ConfirmRequest[] = [];
    const r = await bashTool.execute(
      { command: "rm -rf ./build" },
      {
        ...baseCtx(),
        confirm: (req) => {
          prompts.push(req);
          return Promise.resolve(false);
        },
      },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("denied");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.reason).toContain("deletion");
  });

  it("proceeds when confirm hook approves", async () => {
    const r = await bashTool.execute(
      { command: "echo destructive" },
      { ...baseCtx(), confirm: () => Promise.resolve(true) },
    );
    expect(r.isError).toBeUndefined();
  });

  it("allows destructive commands by default when no confirm hook", async () => {
    // Sprint 2 default: no prompt wired → allow. Sprint 3 replaces this.
    // Use an innocuous command that triggers the confirm pattern.
    const r = await bashTool.execute({ command: "chmod 777 /dev/null" }, baseCtx());
    // Won't succeed on the OS permissions-wise but will run; we only check
    // that it wasn't short-circuited as blocked/denied.
    expect(r.content).not.toContain("blocked");
    expect(r.content).not.toContain("denied");
  });

  it("kills a process that exceeds timeout", async () => {
    const r = await bashTool.execute({ command: "sleep 5", timeout_ms: 200 }, baseCtx());
    expect(r.isError).toBe(true);
    expect(r.content).toContain("timed out");
  });

  it("respects external abort signal", async () => {
    const controller = new AbortController();
    const promise = bashTool.execute({ command: "sleep 5" }, { cwd, signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.content).toContain("aborted");
  });
});
