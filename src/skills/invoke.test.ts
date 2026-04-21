import { describe, expect, it } from "bun:test";

import { applySkill } from "./invoke.ts";

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
