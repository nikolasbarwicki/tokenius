// Skill invocation — pure helper. The CLI (Sprint 6) parses `/skill:<name>`
// from user input, looks the skill up in the list discovered at session
// start, and calls applySkill to produce the final user message. No disk
// I/O here — discovery is a session-level concern.

import type { Skill } from "./types.ts";

export function applySkill(skill: Skill, userPrompt: string): string {
  const trimmed = userPrompt.trim();
  if (trimmed.length === 0) {
    return skill.content;
  }
  return `${skill.content}\n\n---\n\nUser request: ${trimmed}`;
}
