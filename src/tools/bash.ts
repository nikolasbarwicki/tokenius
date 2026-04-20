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

    // Combine the external AbortSignal (Ctrl+C from agent loop) with our
    // internal timeout into one signal for Bun.spawn.
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort("timeout"), timeout);
    const composed = AbortSignal.any([context.signal, timeoutController.signal]);

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;

    try {
      const proc = Bun.spawn(["/bin/sh", "-c", params.command], {
        cwd: context.cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
        signal: composed,
      });

      [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      await proc.exited;
      exitCode = proc.exitCode;
    } catch (error) {
      // Bun.spawn usually resolves even when aborted (the process is killed,
      // exitCode becomes non-null). A throw here means something went wrong
      // before spawn completed.
      clearTimeout(timer);
      if (context.signal.aborted) {
        return { content: "bash aborted by user", isError: true };
      }
      return {
        content: `bash error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
    clearTimeout(timer);

    // Check post-hoc: did we abort or time out? The spawn aborts silently on
    // macOS (exitCode null or 143). Inspect the signals we controlled.
    if (context.signal.aborted) {
      return { content: "bash aborted by user", isError: true };
    }
    if (timeoutController.signal.aborted) {
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
