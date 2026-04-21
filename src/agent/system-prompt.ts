// System prompt assembly. Built once per session and passed to every LLM call
// so Anthropic's prompt caching can hit across turns. That means NO dynamic
// content here (no timestamps, no turn counts, no per-call state). Anything
// the prompt mentions must be stable for the life of the session.
//
// The skills section lists available skills (name + description). Full skill
// content is injected into the user message when the user invokes
// `/skill:<name>` — keeping the prefix small and the cache hot.

import type { AgentConfig } from "./types.ts";
import type { Skill } from "@/skills/types.ts";

export interface SystemPromptOptions {
  agent: AgentConfig;
  /** Contents of AGENTS.md, or null if absent. Loaded by the caller. */
  agentsMd?: string | null;
  /** Skills discovered at session start. Empty array when none. */
  skills?: readonly Skill[];
}

const SECURITY_RULES = `## Security Rules
- Never read or write files outside the project directory.
- Never write secrets or API keys to files — reference them via environment variables.
- Destructive commands (rm -rf, git reset --hard, force push, etc.) will prompt for user confirmation.`;

function renderSkills(skills: readonly Skill[]): string {
  const lines = skills.map((s) =>
    s.description ? `- \`/skill:${s.name}\` — ${s.description}` : `- \`/skill:${s.name}\``,
  );
  return `## Available Skills\n\nThe user can invoke a skill by typing \`/skill:<name>\` in their message. When they do, the skill's instructions will be prepended to their request.\n\n${lines.join("\n")}`;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const parts: string[] = [options.agent.systemPrompt.trim()];

  if (options.agentsMd && options.agentsMd.trim().length > 0) {
    parts.push(`## Project Rules (AGENTS.md)\n\n${options.agentsMd.trim()}`);
  }

  if (options.skills && options.skills.length > 0) {
    parts.push(renderSkills(options.skills));
  }

  parts.push(SECURITY_RULES);

  return parts.join("\n\n");
}
