import { describe, expect, it } from "bun:test";

import { containsSecrets } from "./secrets-detection.ts";

describe("containsSecrets", () => {
  it("detects Anthropic API keys", () => {
    const result = containsSecrets('const key = "sk-ant-abc123def456ghijklmnopqrstuvwx"');
    expect(result.found).toBe(true);
    expect(result.labels).toContain("Anthropic API key");
  });

  it("detects OpenAI keys", () => {
    const result = containsSecrets("sk-abcdefghijklmnopqrstuvwxyz12");
    expect(result.found).toBe(true);
  });

  it("detects GitHub tokens", () => {
    const result = containsSecrets("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(result.found).toBe(true);
    expect(result.labels).toContain("GitHub personal token");
  });

  it("detects AWS access keys", () => {
    const result = containsSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(result.found).toBe(true);
  });

  it("detects generic key/value secrets", () => {
    const result = containsSecrets('api_key = "aBc123DeF456GhI789JkL012MnO345PqR678StU901"');
    expect(result.found).toBe(true);
  });

  it("ignores placeholder values", () => {
    expect(containsSecrets('api_key = "YOUR_API_KEY_HERE_placeholder"').found).toBe(false);
    expect(containsSecrets('token = "changeme_long_placeholder_value_xxx"').found).toBe(false);
  });

  it("does not flag short or low-entropy values", () => {
    expect(containsSecrets('const name = "foo"').found).toBe(false);
    expect(containsSecrets("api_key = short").found).toBe(false);
  });

  it("does not flag prose or code without secrets", () => {
    const code = `function foo() { return "hello world"; }`;
    expect(containsSecrets(code).found).toBe(false);
  });
});
