// Skill invocation — pure helpers. The CLI (Sprint 6) parses `/skill:<name>`
// from user input, looks the skill up in the list discovered at session
// start, and calls applySkill to produce the final user message. No disk
// I/O here — discovery is a session-level concern.

import type { Skill } from "./types.ts";

export const SKILL_PREFIX = "/skill:";

export interface SkillInvocation {
  name: string;
  prompt: string;
}

/**
 * Parse a user line of the form `/skill:<name> <rest>`. Returns null when
 * the line is not a skill invocation, and an object with an empty `name`
 * when the prefix is present but the name is missing — the caller reports
 * that as a user error.
 */
export function parseSkillInvocation(input: string): SkillInvocation | null {
  if (!input.startsWith(SKILL_PREFIX)) {
    return null;
  }
  const rest = input.slice(SKILL_PREFIX.length);
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    return { name: rest.trim(), prompt: "" };
  }
  return { name: rest.slice(0, firstSpace).trim(), prompt: rest.slice(firstSpace + 1) };
}

export function applySkill(skill: Skill, userPrompt: string): string {
  const trimmed = userPrompt.trim();
  if (trimmed.length === 0) {
    return skill.content;
  }
  return `${skill.content}\n\n---\n\nUser request: ${trimmed}`;
}
