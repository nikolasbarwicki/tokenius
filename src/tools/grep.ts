import { readFile } from "node:fs/promises";
import { sep } from "node:path";

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

/** Reset cached ripgrep detection. Test-only. */
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
    const searchPath = params.path ?? ".";
    const check = validatePath(searchPath, context.cwd);
    if (!check.valid) {
      return { content: `grep blocked: ${check.reason}`, isError: true };
    }

    if (await hasRipgrep()) {
      return runRipgrep(params, check.resolved, context.cwd, context.signal);
    }
    return runFallback(params, check.resolved, context.signal);
  },
};

// --- Ripgrep path ---

async function runRipgrep(
  params: GrepParams,
  resolved: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
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
  args.push("--", params.pattern, resolved);

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
    signal,
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
}

// --- Pure-Bun fallback ---
//
// When rg is absent we walk the tree with `Bun.Glob`, skip the usual
// throw-away directories, and run the JS regex engine per file. This is
// orders of magnitude slower than rg on large trees, but it keeps the tool
// usable on machines without it (CI, fresh clones).
//
// Notable differences from rg we're accepting:
//   * Regex flavor is JS (not rust). Most patterns overlap; a handful of rg
//     features (\pL, possessive quantifiers) will silently fail to match.
//   * No binary-file detection — we read as UTF-8 and lines with null bytes
//     just don't match. Simpler than sniffing.
//   * No .gitignore. We hard-code a small denylist below.

// Directories we always skip beyond what `dot: false` already excludes.
// (`.git` and `.tokenius` are covered by `dot: false`; listed here only as a
// safety net if we ever flip that flag.)
const FALLBACK_IGNORE = new Set(["node_modules", "dist"]);

/** Cap on total bytes read to keep a rogue invocation from OOMing. */
const FALLBACK_BYTE_BUDGET = 50_000_000;

/** Cap on total reported matches to keep output bounded. */
const FALLBACK_MATCH_LIMIT = 500;

async function runFallback(
  params: GrepParams,
  resolved: string,
  signal: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  let regex: RegExp;
  try {
    regex = new RegExp(params.pattern, params.ignore_case ? "i" : "");
  } catch (error) {
    return { content: `grep: invalid regex: ${(error as Error).message}`, isError: true };
  }

  const include = params.include ? new Bun.Glob(params.include) : null;
  const lines: string[] = [];
  const seenFiles = new Set<string>();
  let bytesRead = 0;
  let matchCount = 0;

  // Bun.Glob with `**/*` walks recursively. We filter out ignored dirs by
  // checking each path segment — cheaper than trying to express the exclusion
  // as a glob.
  const walker = new Bun.Glob("**/*");
  for await (const rel of walker.scan({ cwd: resolved, onlyFiles: true, dot: false })) {
    if (signal.aborted) {
      break;
    }
    if (isIgnored(rel)) {
      continue;
    }
    // oxlint-disable-next-line prefer-regexp-test -- `include` is a Bun.Glob, not a RegExp
    if (include && !include.match(rel)) {
      continue;
    }

    let contents: string;
    try {
      contents = await readFile(`${resolved}${sep}${rel}`, "utf8");
    } catch {
      // Permission errors, vanishing files — just skip.
      continue;
    }
    bytesRead += contents.length;
    if (bytesRead > FALLBACK_BYTE_BUDGET) {
      lines.push(`(search truncated: read budget of ${FALLBACK_BYTE_BUDGET} bytes exceeded)`);
      break;
    }

    if (params.files_only) {
      if (regex.test(contents) && !seenFiles.has(rel)) {
        seenFiles.add(rel);
        lines.push(rel);
        matchCount++;
        if (matchCount >= FALLBACK_MATCH_LIMIT) {
          break;
        }
      }
      continue;
    }

    const fileLines = contents.split("\n");
    for (let i = 0; i < fileLines.length; i++) {
      if (regex.test(fileLines[i] ?? "")) {
        lines.push(`${rel}:${i + 1}:${fileLines[i] ?? ""}`);
        matchCount++;
        if (matchCount >= FALLBACK_MATCH_LIMIT) {
          lines.push(`(search truncated: ${FALLBACK_MATCH_LIMIT}-match limit reached)`);
          break;
        }
      }
    }
    if (matchCount >= FALLBACK_MATCH_LIMIT) {
      break;
    }
  }

  if (lines.length === 0) {
    return { content: `(no matches for pattern: ${params.pattern})` };
  }
  return { content: `${lines.join("\n")}\n` };
}

function isIgnored(relPath: string): boolean {
  for (const segment of relPath.split(sep)) {
    if (FALLBACK_IGNORE.has(segment)) {
      return true;
    }
  }
  return false;
}
