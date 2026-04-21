// Project-level instructions. Loaded once at session start and passed to
// buildSystemPrompt, which renders them under "## Project Rules (AGENTS.md)".
//
// Intentionally dumb: no parsing, no size cap, no validation. The file is
// user-authored prose and gets appended verbatim. Missing file is the common
// case, not an error.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadAgentsMd(cwd: string): string | null {
  const path = join(cwd, "AGENTS.md");
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, "utf8");
}
