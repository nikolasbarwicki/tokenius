import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import { validatePath } from "@/security/path-validation.ts";
import { containsSecrets } from "@/security/secrets-detection.ts";

import type { ToolDefinition } from "./types.ts";

interface WriteParams {
  path: string;
  content: string;
}

export const writeTool: ToolDefinition<WriteParams> = {
  name: "write",
  description:
    "Create or overwrite a file with the given content. Creates parent directories as needed.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to cwd." },
      content: { type: "string", description: "Full file content." },
    },
    required: ["path", "content"],
  },
  async execute(params, context) {
    const check = validatePath(params.path, context.cwd);
    if (!check.valid) {
      return { content: `write blocked: ${check.reason}`, isError: true };
    }

    const secrets = containsSecrets(params.content);
    if (secrets.found) {
      return {
        content: `write blocked: content appears to contain secrets (${secrets.labels.join(", ")}). Remove the credential and reference it via an environment variable instead.`,
        isError: true,
      };
    }

    await mkdir(dirname(check.resolved), { recursive: true });
    await Bun.write(check.resolved, params.content);

    const bytes = Buffer.byteLength(params.content, "utf8");
    const lines = params.content.split("\n").length;
    return { content: `wrote ${params.path} (${lines} lines, ${bytes}B)` };
  },
};
