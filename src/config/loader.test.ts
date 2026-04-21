import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, loadConfig } from "./loader.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-config-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  writeFileSync(join(cwd, "tokenius.json"), content);
}

describe("loadConfig", () => {
  it("returns defaults when tokenius.json is absent", () => {
    expect(loadConfig(cwd)).toEqual(DEFAULT_CONFIG);
  });

  it("returns defaults for an empty JSON object", () => {
    writeConfig("{}");
    expect(loadConfig(cwd)).toEqual(DEFAULT_CONFIG);
  });

  it("merges partial config over defaults", () => {
    writeConfig(JSON.stringify({ model: "claude-haiku-4-5-20251001" }));
    expect(loadConfig(cwd)).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
    });
  });

  it("infers provider from model when provider is omitted", () => {
    writeConfig(JSON.stringify({ model: "gpt-5.4-mini" }));
    expect(loadConfig(cwd)).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("accepts a full valid config", () => {
    writeConfig(JSON.stringify({ provider: "openai", model: "gpt-5.4-mini" }));
    expect(loadConfig(cwd)).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
  });

  it("throws on invalid JSON", () => {
    writeConfig("{ not json");
    expect(() => loadConfig(cwd)).toThrow(/Invalid JSON in tokenius.json/);
  });

  it("throws on unknown provider", () => {
    writeConfig(JSON.stringify({ provider: "mistral", model: "claude-sonnet-4-6" }));
    expect(() => loadConfig(cwd)).toThrow(/provider/);
  });

  it("throws on unknown model", () => {
    writeConfig(JSON.stringify({ provider: "anthropic", model: "claude-future-9000" }));
    expect(() => loadConfig(cwd)).toThrow(/Unknown model/);
  });

  it("throws when model provider does not match config provider", () => {
    writeConfig(JSON.stringify({ provider: "openai", model: "claude-sonnet-4-6" }));
    expect(() => loadConfig(cwd)).toThrow(/belongs to provider/);
  });

  it("rejects unknown top-level keys", () => {
    writeConfig(JSON.stringify({ provider: "anthropic", model: "claude-sonnet-4-6", foo: 1 }));
    expect(() => loadConfig(cwd)).toThrow(/Invalid tokenius.json/);
  });

  it("accepts a baseUrl override", () => {
    writeConfig(
      JSON.stringify({
        provider: "openai",
        model: "gpt-5.4-mini",
        baseUrl: "https://api.x.ai/v1",
      }),
    );
    expect(loadConfig(cwd)).toEqual({
      provider: "openai",
      model: "gpt-5.4-mini",
      baseUrl: "https://api.x.ai/v1",
    });
  });

  it("rejects a non-URL baseUrl", () => {
    writeConfig(JSON.stringify({ model: "gpt-5.4-mini", baseUrl: "not a url" }));
    expect(() => loadConfig(cwd)).toThrow(/Invalid tokenius.json/);
  });
});
