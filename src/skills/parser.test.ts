import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFrontmatter, parseSkill } from "./parser.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tokenius-skill-parser-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(folder: string, contents: string): string {
  const dir = join(root, folder);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  writeFileSync(path, contents);
  return path;
}

describe("parseFrontmatter", () => {
  it("extracts key/value pairs and the body", () => {
    const { frontmatter, body } = parseFrontmatter(
      "---\nname: foo\ndescription: Bar\n---\n\nHello body\n",
    );
    expect(frontmatter).toEqual({ name: "foo", description: "Bar" });
    expect(body.trim()).toBe("Hello body");
  });

  it("handles multi-line string values (block scalar)", () => {
    const { frontmatter } = parseFrontmatter(
      "---\nname: foo\ndescription: |\n  one\n  two\n---\nbody\n",
    );
    expect(frontmatter.description).toBe("one\ntwo\n");
  });

  it("returns empty frontmatter when no delimiters are present", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a heading\n\ntext");
    expect(frontmatter).toEqual({});
    expect(body).toContain("Just a heading");
  });

  it("throws on malformed YAML", () => {
    expect(() => parseFrontmatter("---\nname: : :\n  bad indent\n---\nbody")).toThrow(
      /Malformed frontmatter/,
    );
  });
});

describe("parseSkill", () => {
  it("uses frontmatter name and description", () => {
    const path = writeSkill(
      "code-review",
      "---\nname: code-review\ndescription: Review code\n---\n\nInstructions here.",
    );
    const skill = parseSkill(path);
    expect(skill.name).toBe("code-review");
    expect(skill.description).toBe("Review code");
    expect(skill.content).toBe("Instructions here.");
    expect(skill.path).toBe(path);
  });

  it("falls back to folder name when frontmatter is absent", () => {
    const path = writeSkill("explain-diff", "No frontmatter here, just body.\n");
    const skill = parseSkill(path);
    expect(skill.name).toBe("explain-diff");
    expect(skill.description).toBe("");
    expect(skill.content).toContain("No frontmatter");
  });

  it("rejects uppercase / non-kebab names", () => {
    const path = writeSkill("code-review", "---\nname: CodeReview\n---\nbody");
    expect(() => parseSkill(path)).toThrow(/Invalid skill name/);
  });

  it("rejects empty name override", () => {
    const path = writeSkill("code-review", "---\nname: ''\n---\nbody");
    expect(() => parseSkill(path)).toThrow(/Invalid skill name/);
  });

  it("rejects malformed folder names via the fallback", () => {
    const path = writeSkill("BadName_Folder", "just body");
    expect(() => parseSkill(path)).toThrow(/Invalid skill name/);
  });

  it("ignores non-string description", () => {
    const path = writeSkill("code-review", "---\nname: code-review\ndescription: 42\n---\nbody");
    const skill = parseSkill(path);
    expect(skill.description).toBe("");
  });

  it("surfaces malformed YAML through parseSkill", () => {
    const path = writeSkill("code-review", "---\nname: : :\n  bad\n---\nbody");
    expect(() => parseSkill(path)).toThrow(/Malformed frontmatter/);
  });
});
