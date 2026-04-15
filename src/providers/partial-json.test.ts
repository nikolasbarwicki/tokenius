import { describe, expect, test } from "bun:test";

import { parsePartialJson } from "./partial-json.ts";

// Helper to work around Bun's Expect<unknown> + exactOptionalPropertyTypes
// strictness where toEqual() only accepts `undefined` for unknown types.
function expectParsed(input: string) {
  // eslint-disable-next-line typescript/no-explicit-any -- test helper to bypass strict Expect<unknown>
  return expect(parsePartialJson(input) as any);
}

describe("parsePartialJson", () => {
  describe("complete JSON (no recovery needed)", () => {
    test("parses a valid object", () => {
      expectParsed('{"name": "hello"}').toEqual({ name: "hello" });
    });

    test("parses a valid array", () => {
      expectParsed("[1, 2, 3]").toEqual([1, 2, 3]);
    });

    test("parses nested structures", () => {
      expectParsed('{"a": {"b": [1, 2]}}').toEqual({ a: { b: [1, 2] } });
    });

    test("parses empty object", () => {
      expectParsed("{}").toEqual({});
    });
  });

  describe("unclosed strings", () => {
    test("closes an unclosed string value", () => {
      expectParsed('{"name": "hel').toEqual({ name: "hel" });
    });

    test("closes a string with escaped quote inside", () => {
      expectParsed('{"text": "say \\"hi').toEqual({ text: 'say "hi' });
    });

    test("handles string with newline escape", () => {
      expectParsed('{"a": "line1\\nli').toEqual({ a: "line1\nli" });
    });
  });

  describe("unclosed brackets and braces", () => {
    test("closes unclosed array", () => {
      expectParsed('{"items": [1, 2').toEqual({ items: [1, 2] });
    });

    test("closes nested unclosed objects", () => {
      expectParsed('{"a": {"b": 1').toEqual({ a: { b: 1 } });
    });

    test("closes deeply nested structures", () => {
      expectParsed('{"a": [{"b": [1').toEqual({ a: [{ b: [1] }] });
    });
  });

  describe("trailing incomplete key-value pairs", () => {
    test("strips trailing colon (incomplete value)", () => {
      expectParsed('{"key":').toEqual({});
    });

    test("strips trailing comma and incomplete key", () => {
      expectParsed('{"a": true, "b":').toEqual({ a: true });
    });

    test("strips trailing comma with partial key", () => {
      expectParsed('{"a": true, "b').toEqual({ a: true });
    });

    test("strips trailing comma", () => {
      expectParsed('{"a": 1,').toEqual({ a: 1 });
    });
  });

  describe("edge cases", () => {
    test("returns empty object for empty string", () => {
      expectParsed("").toEqual({});
    });

    test("returns empty object for just an opening brace", () => {
      expectParsed("{").toEqual({});
    });

    test("returns empty object for completely invalid input", () => {
      expectParsed("not json at all").toEqual({});
    });

    test("handles boolean values", () => {
      expectParsed('{"flag": true').toEqual({ flag: true });
    });

    test("handles null values", () => {
      expectParsed('{"val": null').toEqual({ val: null });
    });

    test("handles numeric values", () => {
      expectParsed('{"count": 42').toEqual({ count: 42 });
    });
  });
});
