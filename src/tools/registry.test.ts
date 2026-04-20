import { afterEach, describe, expect, it } from "bun:test";

import { clearTools, getTool, getToolSchemas, registerTool } from "./registry.ts";

import type { ToolDefinition } from "./types.ts";

function makeTool(name: string): ToolDefinition {
  return {
    name,
    description: `desc for ${name}`,
    parameters: { type: "object", properties: {} },
    execute() {
      return Promise.resolve({ content: "" });
    },
  };
}

describe("tool registry", () => {
  afterEach(() => clearTools());

  it("registers and retrieves tools", () => {
    const tool = makeTool("read");
    registerTool(tool);
    expect(getTool("read")).toBe(tool);
    expect(getTool("missing")).toBeUndefined();
  });

  it("getToolSchemas returns schemas sorted by name for cache stability", () => {
    registerTool(makeTool("write"));
    registerTool(makeTool("bash"));
    registerTool(makeTool("read"));

    const schemas = getToolSchemas(["write", "bash", "read"]);
    expect(schemas.map((s) => s.name)).toEqual(["bash", "read", "write"]);
  });

  it("getToolSchemas order is identical regardless of input order", () => {
    registerTool(makeTool("edit"));
    registerTool(makeTool("grep"));
    registerTool(makeTool("glob"));

    const a = getToolSchemas(["grep", "glob", "edit"]).map((s) => s.name);
    const b = getToolSchemas(["edit", "glob", "grep"]).map((s) => s.name);
    expect(a).toEqual(b);
  });

  it("skips unknown tool names silently", () => {
    registerTool(makeTool("read"));
    const schemas = getToolSchemas(["read", "does-not-exist"]);
    expect(schemas.map((s) => s.name)).toEqual(["read"]);
  });
});
