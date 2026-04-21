import { describe, expect, it } from "bun:test";

import { applySkill, parseSkillInvocation } from "./invoke.ts";

import type { Skill } from "./types.ts";

const skill: Skill = {
  name: "review",
  description: "Review code",
  content: "Review thoroughly.",
  path: "/fake/path/SKILL.md",
};

describe("applySkill", () => {
  it("prepends skill content to the user prompt", () => {
    const result = applySkill(skill, "check src/foo.ts");
    expect(result.startsWith("Review thoroughly.")).toBe(true);
    expect(result).toContain("User request: check src/foo.ts");
  });

  it("returns just skill content when prompt is empty", () => {
    expect(applySkill(skill, "")).toBe("Review thoroughly.");
    expect(applySkill(skill, "   \n")).toBe("Review thoroughly.");
  });

  it("trims the user prompt before embedding", () => {
    const result = applySkill(skill, "  do it  \n");
    expect(result).toContain("User request: do it");
  });
});

describe("parseSkillInvocation", () => {
  it("returns null for non-skill input", () => {
    expect(parseSkillInvocation("/help")).toBeNull();
    expect(parseSkillInvocation("hello")).toBeNull();
    expect(parseSkillInvocation("/skills")).toBeNull();
  });

  it("parses a skill name with a prompt", () => {
    expect(parseSkillInvocation("/skill:review src/foo.ts")).toEqual({
      name: "review",
      prompt: "src/foo.ts",
    });
  });

  it("parses a skill name without a prompt", () => {
    expect(parseSkillInvocation("/skill:review")).toEqual({ name: "review", prompt: "" });
  });

  it("trims surrounding whitespace on the name (e.g. `/skill: summarize foo`)", () => {
    expect(parseSkillInvocation("/skill: summarize foo")).toEqual({
      name: "",
      prompt: "summarize foo",
    });
  });

  it("preserves leading whitespace inside the prompt body", () => {
    // Only the first space is the separator; everything after is prompt.
    expect(parseSkillInvocation("/skill:review   padded  ")).toEqual({
      name: "review",
      prompt: "  padded  ",
    });
  });
});
