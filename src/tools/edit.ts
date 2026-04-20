import { existsSync } from "node:fs";

import { validatePath } from "@/security/path-validation.ts";
import { containsSecrets } from "@/security/secrets-detection.ts";

import type { ToolDefinition } from "./types.ts";

interface EditParams {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export const editTool: ToolDefinition<EditParams> = {
  name: "edit",
  description:
    "`old_string` must match exactly once in the file — include enough surrounding context (whitespace and adjacent lines) to make it unique. Pass `replace_all: true` for renames. Replaces `old_string` with `new_string`.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to find." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: {
        type: "boolean",
        description: "Replace every occurrence. Default: false.",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  async execute(params, context) {
    const check = validatePath(params.path, context.cwd);
    if (!check.valid) {
      return { content: `edit blocked: ${check.reason}`, isError: true };
    }

    if (!existsSync(check.resolved)) {
      return { content: `file not found: ${params.path}`, isError: true };
    }

    if (params.old_string === params.new_string) {
      return { content: "edit no-op: old_string equals new_string", isError: true };
    }

    if (params.old_string.length === 0) {
      return {
        content: "edit error: old_string cannot be empty. Use the `write` tool to create files.",
        isError: true,
      };
    }

    const secrets = containsSecrets(params.new_string);
    if (secrets.found) {
      return {
        content: `edit blocked: new_string appears to contain secrets (${secrets.labels.join(", ")}). Reference it via an environment variable instead.`,
        isError: true,
      };
    }

    const original = await Bun.file(check.resolved).text();
    const count = countOccurrences(original, params.old_string);

    if (count === 0) {
      return {
        content: `edit error: old_string not found in ${params.path}. Read the file and copy the exact text (including whitespace).`,
        isError: true,
      };
    }

    const replaceAll = params.replace_all ?? false;
    if (!replaceAll && count > 1) {
      return {
        content: `edit error: old_string matches ${count} times in ${params.path}. Provide more surrounding context to uniquely identify the target, or pass replace_all: true.`,
        isError: true,
      };
    }

    const updated = replaceAll
      ? original.split(params.old_string).join(params.new_string)
      : original.replace(params.old_string, params.new_string);

    await Bun.write(check.resolved, updated);

    const replacements = replaceAll ? count : 1;
    return {
      content: `edited ${params.path}: ${replacements} replacement${replacements === 1 ? "" : "s"}`,
    };
  },
};

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let i = 0;
  while (true) {
    const idx = haystack.indexOf(needle, i);
    if (idx === -1) {
      break;
    }
    count++;
    i = idx + needle.length;
  }
  return count;
}
