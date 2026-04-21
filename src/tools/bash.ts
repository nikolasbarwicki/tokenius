import { checkCommand } from "@/security/command-detection.ts";

import type { ToolDefinition } from "./types.ts";

interface BashParams {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

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

    let timedOut = false;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;

    const proc = Bun.spawn(["/bin/sh", "-c", params.command], {
      cwd: context.cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });

    // Kill the child explicitly on abort/timeout. Relying on Bun.spawn's
    // `signal` option is flaky on Linux + Bun 1.3.0: the process doesn't
    // always terminate and the stream readers hang.
    const onAbort = () => {
      try {
        proc.kill("SIGTERM");
      } catch {
        // process already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      onAbort();
    }, timeout);
    context.signal.addEventListener("abort", onAbort, { once: true });

    try {
      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      exitCode = proc.exitCode;
    } catch (error) {
      return {
        content: `bash error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onAbort);
    }

    if (context.signal.aborted) {
      return { content: "bash aborted by user", isError: true };
    }
    if (timedOut) {
      return {
        content: `[timed out after ${timeout}ms]\n${stdout}${stderr}`,
        isError: true,
      };
    }

    const combined = stdout + stderr;
    if (exitCode !== null && exitCode !== 0) {
      return { content: `[exit ${exitCode}]\n${combined}`, isError: true };
    }
    return { content: combined };
  },
};
