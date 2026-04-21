// System prompt assembly. Built once per session and passed to every LLM call
// so Anthropic's prompt caching can hit across turns. That means NO dynamic
// content here (no timestamps, no turn counts, no per-call state). Anything
// the prompt mentions must be stable for the life of the session.
//
// Skills discovery lands in Sprint 5; this builder intentionally has no hook
// for them yet — adding one now would force a placeholder in the prompt text
// and pollute the cache prefix. Sprint 5 adds an optional `skills` param and
// a corresponding section between AGENTS.md and the security rules.

import type { AgentConfig } from "./types.ts";

export interface SystemPromptOptions {
  agent: AgentConfig;
  /** Contents of AGENTS.md, or null if absent. Loaded by the caller. */
  agentsMd?: string | null;
}

const SECURITY_RULES = `## Security Rules
- Never read or write files outside the project directory.
- Never write secrets or API keys to files — reference them via environment variables.
- Destructive commands (rm -rf, git reset --hard, force push, etc.) will prompt for user confirmation.`;

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const parts: string[] = [options.agent.systemPrompt.trim()];

  if (options.agentsMd && options.agentsMd.trim().length > 0) {
    parts.push(`## Project Rules (AGENTS.md)\n\n${options.agentsMd.trim()}`);
  }

  parts.push(SECURITY_RULES);

  return parts.join("\n\n");
}
