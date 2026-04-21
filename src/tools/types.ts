import type { ToolSchema } from "@/types.ts";

// --- JSON Schema subset ---
//
// We deliberately restrict to the shapes we actually use. Keeps the validator
// small (tools/validation.ts) and the schemas easy to read. Extend only when
// a new tool needs something we don't support yet.

export type JsonSchemaPrimitive = "string" | "number" | "integer" | "boolean";

export type JsonSchemaProperty =
  | {
      type: JsonSchemaPrimitive;
      description?: string;
      enum?: readonly string[];
      minimum?: number;
      maximum?: number;
    }
  | {
      type: "array";
      description?: string;
      items: { type: JsonSchemaPrimitive };
    };

export interface JsonSchema {
  type: "object";
  properties: Record<string, JsonSchemaProperty>;
  required?: readonly string[];
}

// --- Tool execution ---

export interface ConfirmRequest {
  tool: string;
  description: string; // Human-readable preview of what will happen
  reason: string; // Why confirmation is needed
}

export interface ToolContext {
  cwd: string;
  signal: AbortSignal;
  /**
   * Confirmation hook for operations flagged by command-detection or similar.
   *
   * When invoked by the agent loop, this is pre-resolved: the loop runs its
   * own permission prompt upfront (see `resolveValidatedPermissions`) and
   * passes an always-allow hook so tools don't double-prompt. Denials become
   * validation errors before `execute` is called.
   *
   * The hook remains in the interface so tools can still be driven directly
   * (tests, future callers) without going through the loop.
   */
  confirm?: (request: ConfirmRequest) => Promise<boolean>;
}

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolDefinition<TParams = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: JsonSchema;
  execute: (params: TParams, context: ToolContext) => Promise<ToolResult>;
}

// --- Conversion to wire format ---

export function toToolSchema(def: ToolDefinition): ToolSchema {
  return {
    name: def.name,
    description: def.description,
    inputSchema: def.parameters as unknown as Record<string, unknown>,
  };
}
