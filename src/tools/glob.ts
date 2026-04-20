import { relative, resolve } from "node:path";

import { validatePath } from "@/security/path-validation.ts";

import type { ToolDefinition } from "./types.ts";

interface GlobParams {
  pattern: string;
  path?: string;
  dot?: boolean;
}

export const globTool: ToolDefinition<GlobParams> = {
  name: "glob",
  description:
    "Find files matching a glob pattern (e.g. 'src/**/*.ts'). Returns sorted relative paths. Dotfiles/dotdirs (.github, .claude) are excluded by default — pass `dot: true` to include them.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern, e.g. 'src/**/*.ts'" },
      path: { type: "string", description: "Base directory (default: cwd)" },
      dot: {
        type: "boolean",
        description: "Include dotfiles and dotdirs. Default: false.",
      },
    },
    required: ["pattern"],
  },
  async execute(params, context) {
    const base = params.path ?? ".";
    const check = validatePath(base, context.cwd);
    if (!check.valid) {
      return { content: `glob blocked: ${check.reason}`, isError: true };
    }

    const glob = new Bun.Glob(params.pattern);
    const matches: string[] = [];
    for await (const match of glob.scan({
      cwd: check.resolved,
      onlyFiles: true,
      dot: params.dot ?? false,
    })) {
      const absolute = resolve(check.resolved, match);
      // Belt-and-suspenders: drop anything that escaped the search root.
      // Compare against check.resolved (canonicalized) to avoid macOS /tmp
      // vs /private/tmp symlink divergence.
      const rel = relative(check.resolved, absolute);
      if (rel.startsWith("..")) {
        continue;
      }
      matches.push(rel);
    }

    matches.sort();

    if (matches.length === 0) {
      return { content: `(no files matched pattern: ${params.pattern})` };
    }
    return { content: matches.join("\n") };
  },
};
