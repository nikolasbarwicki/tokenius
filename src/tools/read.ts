import { existsSync, statSync } from "node:fs";

import { validatePath } from "@/security/path-validation.ts";

import type { ToolDefinition } from "./types.ts";

interface ReadParams {
  path: string;
  offset?: number;
  limit?: number;
}

const BINARY_SCAN_BYTES = 8_192;
const DEFAULT_LIMIT = 2_000;

export const readTool: ToolDefinition<ReadParams> = {
  name: "read",
  description:
    "Read a file from the project. Returns content with 1-based line numbers (cat -n). Default limit is 2000 lines; pass `offset`/`limit` to page through larger files.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to cwd." },
      offset: { type: "integer", description: "1-based start line.", minimum: 1 },
      limit: {
        type: "integer",
        description: "Max lines to read (default 2000).",
        minimum: 1,
        maximum: DEFAULT_LIMIT,
      },
    },
    required: ["path"],
  },
  async execute(params, context) {
    const check = validatePath(params.path, context.cwd);
    if (!check.valid) {
      return { content: `read blocked: ${check.reason}`, isError: true };
    }

    if (!existsSync(check.resolved)) {
      return { content: `file not found: ${params.path}`, isError: true };
    }
    const stat = statSync(check.resolved);
    if (stat.isDirectory()) {
      return { content: `path is a directory, not a file: ${params.path}`, isError: true };
    }

    const file = Bun.file(check.resolved);

    // Binary sniff — read first chunk as bytes, look for null.
    const head = new Uint8Array(
      await file.slice(0, Math.min(stat.size, BINARY_SCAN_BYTES)).arrayBuffer(),
    );
    if (isBinary(head)) {
      return { content: `(binary file, ${stat.size} bytes)`, isError: false };
    }

    const text = await file.text();
    const lines = text.split("\n");

    const offset = params.offset ?? 1;
    const limit = params.limit ?? DEFAULT_LIMIT;
    const start = offset - 1;
    const end = Math.min(lines.length, start + limit);

    if (start >= lines.length) {
      return {
        content: `offset ${offset} is past end of file (${lines.length} lines)`,
        isError: true,
      };
    }

    const slice = lines.slice(start, end);
    const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`);
    return { content: numbered.join("\n") };
  },
};

function isBinary(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0) {
      return true;
    }
  }
  return false;
}
