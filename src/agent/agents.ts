// Agent configurations. One loop, three personas:
//
//   build   — full tool access. Can read, write, run, search. Spawns subagents.
//   plan    — read-only planner. Analyzes code, produces plans. No mutations.
//   explore — read-only fast searcher. Finds files, answers questions.
//
// Subagents (plan, explore) deliberately omit `spawn_agent` — no recursive
// spawning. maxTurns is tuned per role: build gets 50 (can iterate on fixes),
// plan 20 (depth over breadth), explore 10 (cheap and targeted).

import type { AgentConfig } from "./types.ts";

export const AGENTS = {
  build: {
    name: "build",
    description:
      "Main coding agent with full tool access for reading, writing, and executing code.",
    systemPrompt: `You are Tokenius, a coding assistant. You help users with software engineering tasks.
You have access to tools for reading, writing, editing files, running commands, and searching code.
When a task requires exploration or planning without changes, delegate to a subagent via spawn_agent.
Be concise. Prefer doing over explaining.`,
    tools: ["bash", "read", "write", "edit", "grep", "glob", "spawn_agent"],
    maxTurns: 50,
  },

  plan: {
    name: "plan",
    description:
      "Planning and analysis agent. Reads code, reasons about architecture, produces plans. Cannot modify files or run commands.",
    systemPrompt: `You are a planning assistant. Analyze code, reason about architecture, and produce detailed plans.
You CANNOT modify files or run commands — only read and search.
Be thorough but concise. Structure your output with clear headings.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 20,
  },

  explore: {
    name: "explore",
    description:
      "Fast codebase exploration agent. Searches files, reads code, answers questions. Cannot modify anything.",
    systemPrompt: `You are a codebase exploration assistant. Quickly find files, search patterns, and read code to answer questions.
Be concise — report findings, not process.`,
    tools: ["read", "grep", "glob"],
    maxTurns: 10,
  },
} as const satisfies Record<string, AgentConfig>;

export function getAgent(name: string): AgentConfig | undefined {
  // Object.hasOwn (not `in`) avoids prototype-chain hits like "__proto__"
  // resolving to a function value.
  return Object.hasOwn(AGENTS, name) ? AGENTS[name as keyof typeof AGENTS] : undefined;
}
