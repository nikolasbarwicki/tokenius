import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { MissingApiKeyError, resolveApiKey } from "./api-keys.ts";

const SAVED: Record<string, string | undefined> = {};

beforeEach(() => {
  SAVED.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  SAVED.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.OPENAI_API_KEY;
});

afterEach(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveApiKey", () => {
  it("returns the anthropic key when set", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(resolveApiKey("anthropic")).toBe("sk-ant-test");
  });

  it("returns the openai key when set", () => {
    process.env.OPENAI_API_KEY = "sk-oa-test";
    expect(resolveApiKey("openai")).toBe("sk-oa-test");
  });

  it("throws with the env-var name when anthropic key is missing", () => {
    expect(() => resolveApiKey("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws with the env-var name when openai key is missing", () => {
    expect(() => resolveApiKey("openai")).toThrow(/OPENAI_API_KEY/);
  });

  it("throws when key is set but empty", () => {
    process.env.ANTHROPIC_API_KEY = "";
    expect(() => resolveApiKey("anthropic")).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("throws a MissingApiKeyError with provider + envVar attached", () => {
    try {
      resolveApiKey("openai");
      throw new Error("resolveApiKey should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(MissingApiKeyError);
      expect((error as MissingApiKeyError).provider).toBe("openai");
      expect((error as MissingApiKeyError).envVar).toBe("OPENAI_API_KEY");
    }
  });
});
