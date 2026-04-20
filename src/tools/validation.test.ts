import { describe, expect, it } from "bun:test";

import { validateArgs } from "./validation.ts";

import type { JsonSchema } from "./types.ts";

const schema: JsonSchema = {
  type: "object",
  properties: {
    path: { type: "string" },
    offset: { type: "integer", minimum: 1 },
    mode: { type: "string", enum: ["read", "write"] },
    tags: { type: "array", items: { type: "string" } },
    force: { type: "boolean" },
  },
  required: ["path"],
};

describe("validateArgs", () => {
  it("accepts valid args", () => {
    const result = validateArgs(schema, { path: "foo.ts", offset: 5, mode: "read" });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("reports missing required property", () => {
    const result = validateArgs(schema, { offset: 1 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('missing required property: "path"');
  });

  it("reports wrong type", () => {
    const result = validateArgs(schema, { path: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('"path" must be string');
  });

  it("rejects non-object args", () => {
    const result = validateArgs(schema, "not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["expected arguments to be an object"]);
  });

  it("enforces enum values", () => {
    const result = validateArgs(schema, { path: "x", mode: "delete" });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be one of");
  });

  it("enforces integer minimum", () => {
    const result = validateArgs(schema, { path: "x", offset: 0 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain(">= 1");
  });

  it("rejects non-integer numbers for integer fields", () => {
    const result = validateArgs(schema, { path: "x", offset: 1.5 });
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("must be integer");
  });

  it("validates arrays and their items", () => {
    const ok = validateArgs(schema, { path: "x", tags: ["a", "b"] });
    expect(ok.valid).toBe(true);

    const bad = validateArgs(schema, { path: "x", tags: ["a", 2] });
    expect(bad.valid).toBe(false);
    expect(bad.errors[0]).toContain('"tags[1]"');
  });

  it("ignores unknown properties", () => {
    const result = validateArgs(schema, { path: "x", extra: "ignored" });
    expect(result.valid).toBe(true);
  });

  it("collects multiple errors", () => {
    const result = validateArgs(schema, { offset: "nope", mode: "delete" });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
