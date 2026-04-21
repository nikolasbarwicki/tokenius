import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverSkills, skillsDir } from "./discovery.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-skill-discover-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function writeSkill(name: string, body: string): void {
  const dir = join(skillsDir(cwd), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

describe("discoverSkills", () => {
  it("returns [] when the skills directory is missing", () => {
    expect(discoverSkills(cwd)).toEqual([]);
  });

  it("returns [] for an empty skills directory", () => {
    mkdirSync(skillsDir(cwd), { recursive: true });
    expect(discoverSkills(cwd)).toEqual([]);
  });

  it("discovers skills with SKILL.md files", () => {
    writeSkill("review", "---\nname: review\ndescription: Review code\n---\n\nBody.");
    writeSkill("plan", "---\nname: plan\ndescription: Planning\n---\n\nPlan body.");

    const skills = discoverSkills(cwd);
    expect(skills.map((s) => s.name)).toEqual(["plan", "review"]);
    expect(skills[0]?.description).toBe("Planning");
  });

  it("skips directories without SKILL.md", () => {
    writeSkill("real", "---\nname: real\n---\nbody");
    mkdirSync(join(skillsDir(cwd), "empty"), { recursive: true });
    expect(discoverSkills(cwd).map((s) => s.name)).toEqual(["real"]);
  });

  it("skips non-directory entries at the root", () => {
    mkdirSync(skillsDir(cwd), { recursive: true });
    writeFileSync(join(skillsDir(cwd), "stray.md"), "not a skill");
    writeSkill("real", "---\nname: real\n---\nbody");
    expect(discoverSkills(cwd).map((s) => s.name)).toEqual(["real"]);
  });

  it("returns results sorted by name", () => {
    writeSkill("zeta", "---\nname: zeta\n---\nbody");
    writeSkill("alpha", "---\nname: alpha\n---\nbody");
    writeSkill("mike", "---\nname: mike\n---\nbody");
    expect(discoverSkills(cwd).map((s) => s.name)).toEqual(["alpha", "mike", "zeta"]);
  });

  it("skips a malformed SKILL.md with a stderr warning and keeps the rest", () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeSkill("broken", "---\nname: Bad_Name\n---\nbody");
      writeSkill("ok", "---\nname: ok\n---\nbody");

      expect(discoverSkills(cwd).map((s) => s.name)).toEqual(["ok"]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toMatch(/Skipping skill "broken"/);
    } finally {
      warn.mockRestore();
    }
  });
});
