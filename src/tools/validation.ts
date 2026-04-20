import type { JsonSchema, JsonSchemaProperty } from "./types.ts";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateArgs(schema: JsonSchema, args: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isObject(args)) {
    return { valid: false, errors: ["expected arguments to be an object"] };
  }

  // Required keys
  for (const key of schema.required ?? []) {
    if (!(key in args)) {
      errors.push(`missing required property: "${key}"`);
    }
  }

  // Property shapes
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties[key];
    if (!prop) {
      continue; // Additional properties: ignored, not an error (LLMs sometimes pad).
    }
    const propErrors = validateProperty(key, value, prop);
    errors.push(...propErrors);
  }

  return { valid: errors.length === 0, errors };
}

function validateProperty(key: string, value: unknown, prop: JsonSchemaProperty): string[] {
  const errors: string[] = [];

  if (prop.type === "array") {
    if (!Array.isArray(value)) {
      return [`"${key}" must be an array (got ${describeType(value)})`];
    }
    for (const [i, item] of value.entries()) {
      if (!matchesPrimitive(item, prop.items.type)) {
        errors.push(`"${key}[${i}]" must be ${prop.items.type} (got ${describeType(item)})`);
      }
    }
    return errors;
  }

  if (!matchesPrimitive(value, prop.type)) {
    return [`"${key}" must be ${prop.type} (got ${describeType(value)})`];
  }

  if (prop.type === "string" && prop.enum && !prop.enum.includes(value as string)) {
    errors.push(`"${key}" must be one of [${prop.enum.join(", ")}] (got "${String(value)}")`);
  }

  if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) {
      errors.push(`"${key}" must be >= ${prop.minimum} (got ${value})`);
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      errors.push(`"${key}" must be <= ${prop.maximum} (got ${value})`);
    }
  }

  return errors;
}

function matchesPrimitive(value: unknown, type: JsonSchemaProperty["type"]): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
  }
}

function describeType(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
