import { toToolSchema } from "./types.ts";

import type { ToolDefinition } from "./types.ts";
import type { ToolSchema } from "@/types.ts";

const tools = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  tools.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return tools.get(name);
}

/**
 * Returns the JSON-schema wire format for the requested tools, sorted by name.
 * Sorting is deterministic so Anthropic prompt caching hits across turns — any
 * change in order would invalidate the cache prefix.
 */
export function getToolSchemas(allowedTools: readonly string[]): ToolSchema[] {
  return [...allowedTools]
    .toSorted()
    .map((name) => tools.get(name))
    .filter((t): t is ToolDefinition => t !== undefined)
    .map((t) => toToolSchema(t));
}

/** Clear all registered tools. Use in test teardown only. */
export function clearTools(): void {
  tools.clear();
}
