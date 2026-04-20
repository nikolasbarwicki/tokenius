import { validatePath } from "@/security/path-validation.ts";

import type { ToolDefinition } from "./types.ts";

interface GrepParams {
  pattern: string;
  path?: string;
  include?: string;
  ignore_case?: boolean;
  files_only?: boolean;
}

let rgAvailable: boolean | undefined;

export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) {
    return rgAvailable;
  }
  try {
    const proc = Bun.spawn(["rg", "--version"], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    await proc.exited;
    rgAvailable = proc.exitCode === 0;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

/** Reset cached ripgrep detection. Test-only. @lintignore */
export function resetRipgrepCache(): void {
  rgAvailable = undefined;
}

export const grepTool: ToolDefinition<GrepParams> = {
  name: "grep",
  description:
    "Search file contents with a regex. Uses ripgrep. Output is `path:line:match` per hit (or just `path` when `files_only: true`).",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regex pattern (ripgrep/rust regex flavor)." },
      path: { type: "string", description: "Directory to search (default: cwd)." },
      include: { type: "string", description: "Glob filter, e.g. '*.ts'." },
      ignore_case: {
        type: "boolean",
        description: "Case-insensitive match. Default: false.",
      },
      files_only: {
        type: "boolean",
        description: "Return matching file paths only, no line content. Default: false.",
      },
    },
    required: ["pattern"],
  },
  async execute(params, context) {
    if (!(await hasRipgrep())) {
      return {
        content: "grep requires ripgrep (rg). Install it with `brew install ripgrep`.",
        isError: true,
      };
    }

    const searchPath = params.path ?? ".";
    const check = validatePath(searchPath, context.cwd);
    if (!check.valid) {
      return { content: `grep blocked: ${check.reason}`, isError: true };
    }

    const args = ["rg", "--no-heading", "--color=never"];
    if (params.files_only) {
      args.push("--files-with-matches");
    } else {
      args.push("--line-number");
    }
    if (params.ignore_case) {
      args.push("--ignore-case");
    }
    if (params.include) {
      args.push("--glob", params.include);
    }
    args.push("--", params.pattern, check.resolved);

    const proc = Bun.spawn(args, {
      stdout: "pipe",
      stderr: "pipe",
      cwd: context.cwd,
      signal: context.signal,
    });

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;

    // ripgrep exit codes: 0 = matches, 1 = no matches, 2 = error
    if (proc.exitCode === 1) {
      return { content: `(no matches for pattern: ${params.pattern})` };
    }
    if (proc.exitCode !== 0) {
      return { content: stderr.trim() || `grep failed with exit ${proc.exitCode}`, isError: true };
    }
    return { content: stdout };
  },
};
