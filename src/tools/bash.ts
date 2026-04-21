import { once } from "node:events";

import { checkCommand } from "@/security/command-detection.ts";

import type { ToolDefinition } from "./types.ts";

interface BashParams {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
// After killing the process we wait briefly for the stream readers to see
// EOF and surface any buffered output. 500ms is comfortably longer than the
// kernel takes to deliver SIGKILL and close the pipes, and short enough that
// a stuck reader doesn't hang the tool.
const POST_KILL_GRACE_MS = 500;

export const bashTool: ToolDefinition<BashParams> = {
  name: "bash",
  description:
    "Run a shell command. Returns combined stdout+stderr. Default timeout 120s (max 600s); destructive commands may require user confirmation. Prefer the `read`, `glob`, and `grep` tools over `cat`, `find`, and `grep` — they're faster and return structured output.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      timeout_ms: {
        type: "integer",
        description: "Timeout in milliseconds (default 120000, max 600000).",
        minimum: 1,
        maximum: MAX_TIMEOUT_MS,
      },
    },
    required: ["command"],
  },
  async execute(params, context) {
    const safety = checkCommand(params.command);

    if (!safety.allowed) {
      return { content: `bash blocked: ${safety.reason ?? "command not allowed"}`, isError: true };
    }

    if (safety.requiresConfirmation) {
      // Sprint 2: optional hook on ToolContext; if not present, allow (permissive default).
      // Sprint 3.4 wires a real user prompt via src/security/permissions.ts.
      const approved = context.confirm
        ? await context.confirm({
            tool: "bash",
            description: params.command,
            reason: safety.reason ?? "destructive command",
          })
        : true;
      if (!approved) {
        return { content: "bash cancelled: user denied permission", isError: true };
      }
    }

    const timeout = Math.min(params.timeout_ms ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // Spawn in a new process group so we can kill the shell *and* any
    // forked descendants on abort/timeout. Without this, a grandchild
    // (e.g. `sleep` forked by bash) can keep the pipe write-end open
    // after we kill only the shell, which hangs the stream readers.
    const proc = Bun.spawn(["/bin/sh", "-c", params.command], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
      detached: true,
    });

    // Kill the whole process group. The negative pid targets the group;
    // ESRCH (no such group) means it's already dead, which is fine. Any
    // other error is a real bug — don't swallow it behind a fallback that
    // only kills the shell, since that's the bug we're guarding against.
    const killGroup = () => {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
      }
    };

    // Kick off stream reading once. Later paths await this same promise —
    // the streams can only be consumed once (Response.text() locks them).
    const output = (async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      return { stdout, stderr, exitCode: proc.exitCode };
    })();

    const waitForAbort = async (signal: AbortSignal): Promise<void> => {
      if (signal.aborted) {
        return;
      }
      await once(signal, "abort");
    };
    // AbortSignal.timeout uses an unref-ed timer, so a command that
    // finishes first doesn't leave a dangling handle on the event loop.
    const timeoutSignal = AbortSignal.timeout(timeout);

    const raceOutcome = await Promise.race([
      output.then((r) => ({ kind: "done" as const, ...r })),
      waitForAbort(context.signal).then(() => ({ kind: "aborted" as const })),
      waitForAbort(timeoutSignal).then(() => ({ kind: "timeout" as const })),
    ]);

    if (raceOutcome.kind === "done") {
      const combined = raceOutcome.stdout + raceOutcome.stderr;
      if (raceOutcome.exitCode !== null && raceOutcome.exitCode !== 0) {
        return { content: `[exit ${raceOutcome.exitCode}]\n${combined}`, isError: true };
      }
      return { content: combined };
    }

    killGroup();
    // SIGKILL closes the pipes, so `output` should now resolve with whatever
    // was buffered before the kill. Bound the wait — if something keeps the
    // pipes open (shouldn't happen with a whole-group kill, but don't bet
    // the harness on it), return with empty output rather than hang.
    const graceSignal = AbortSignal.timeout(POST_KILL_GRACE_MS);
    const partial = await Promise.race([
      output.catch(() => ({ stdout: "", stderr: "" })),
      waitForAbort(graceSignal).then(() => ({ stdout: "", stderr: "" })),
    ]);
    const out = partial.stdout + partial.stderr;
    if (raceOutcome.kind === "timeout") {
      return { content: `[timed out after ${timeout}ms]\n${out}`, isError: true };
    }
    return { content: `bash aborted by user\n${out}`, isError: true };
  },
};
