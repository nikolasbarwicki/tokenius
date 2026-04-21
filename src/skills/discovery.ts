// Skill discovery — scans `.tokenius/skills/<name>/SKILL.md` under cwd.
//
// Called once per session (not per turn): the result feeds buildSystemPrompt
// so the skill catalog is part of the cached prefix. That means any skill
// edits show up only in new sessions, which matches how AGENTS.md works.
//
// Malformed skills are skipped with a stderr warning rather than aborting
// the session. One bad SKILL.md in a library of many shouldn't block the
// user from starting; they'd still see the warning and can fix it.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { parseSkill } from "./parser.ts";

import type { Skill } from "./types.ts";

export function skillsDir(cwd: string): string {
  return join(cwd, ".tokenius", "skills");
}

export function discoverSkills(cwd: string): Skill[] {
  const dir = skillsDir(cwd);
  if (!existsSync(dir)) {
    return [];
  }

  const skills: Skill[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(dir, entry.name, "SKILL.md");
    if (!existsSync(path)) {
      continue;
    }
    try {
      skills.push(parseSkill(path));
    } catch (error) {
      console.warn(`[tokenius] Skipping skill "${entry.name}": ${(error as Error).message}`);
    }
  }

  // Stable order so the cached system prompt is deterministic across runs.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}
