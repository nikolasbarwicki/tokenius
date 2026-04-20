import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

export interface PathValidationResult {
  valid: boolean;
  resolved: string; // Absolute path (realpath'd when the file exists)
  reason?: string;
}

const BLOCKED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  "credentials.json",
  "secrets.json",
]);

// Sensitive subpaths. Matched as path segments, not substrings, so a repo
// literally named "objects" wouldn't be flagged unless it's under .git/.
const BLOCKED_SEGMENTS: readonly string[][] = [
  [".git", "objects"],
  [".git", "refs"],
  ["node_modules", ".cache"],
];

/**
 * Validate a path against the project boundary. Returns the absolute resolved
 * path (or best-effort resolution if the file doesn't yet exist — needed for
 * the `write` tool which creates new files).
 */
export function validatePath(filePath: string, cwd: string): PathValidationResult {
  const target = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  const resolvedTarget = canonicalize(target);
  const resolvedCwd = canonicalize(cwd);

  const rel = relative(resolvedCwd, resolvedTarget);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return {
      valid: false,
      resolved: resolvedTarget,
      reason: "path is outside the project directory",
    };
  }

  const name = basename(resolvedTarget);
  if (BLOCKED_FILES.has(name)) {
    return {
      valid: false,
      resolved: resolvedTarget,
      reason: `access to ${name} is blocked for security`,
    };
  }

  const segments = rel.split(sep);
  for (const blocked of BLOCKED_SEGMENTS) {
    if (containsSequence(segments, blocked)) {
      return {
        valid: false,
        resolved: resolvedTarget,
        reason: `access to ${blocked.join("/")} is blocked`,
      };
    }
  }

  return { valid: true, resolved: resolvedTarget };
}

/**
 * Resolve symlinks if the path exists; otherwise resolve the deepest existing
 * ancestor and append the remainder. This lets `write` target new files inside
 * a real (possibly symlinked) directory like `/tmp` on macOS.
 */
function canonicalize(p: string): string {
  if (existsSync(p)) {
    return realpathSync(p);
  }

  // Walk up until we find an existing ancestor, realpath it, reattach the tail.
  const parts = resolve(p).split(sep);
  for (let i = parts.length - 1; i > 0; i--) {
    const ancestor = parts.slice(0, i).join(sep) || sep;
    if (existsSync(ancestor)) {
      const realAncestor = realpathSync(ancestor);
      return [realAncestor, ...parts.slice(i)].join(sep);
    }
  }
  return resolve(p);
}

function containsSequence(haystack: string[], needle: readonly string[]): boolean {
  if (needle.length === 0) {
    return false;
  }
  for (let i = 0; i <= haystack.length - needle.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) {
      return true;
    }
  }
  return false;
}
