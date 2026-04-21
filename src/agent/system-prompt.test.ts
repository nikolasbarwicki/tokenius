import { describe, expect, it } from "bun:test";

import { AGENTS } from "./agents.ts";
import { buildSystemPrompt } from "./system-prompt.ts";

describe("buildSystemPrompt", () => {
  it("includes the agent's systemPrompt", () => {
    const prompt = buildSystemPrompt({ agent: AGENTS.build });
    expect(prompt).toContain("Tokenius");
    expect(prompt).toContain("software engineering tasks");
  });

  it("always appends the security rules", () => {
    const prompt = buildSystemPrompt({ agent: AGENTS.explore });
    expect(prompt).toContain("## Security Rules");
    expect(prompt).toContain("outside the project directory");
  });

  it("omits the AGENTS.md section when agentsMd is null", () => {
    const prompt = buildSystemPrompt({ agent: AGENTS.build, agentsMd: null });
    expect(prompt).not.toContain("AGENTS.md");
    expect(prompt).not.toContain("Project Rules");
  });

  it("omits the AGENTS.md section when agentsMd is empty/whitespace", () => {
    const prompt = buildSystemPrompt({ agent: AGENTS.build, agentsMd: "   \n\n  " });
    expect(prompt).not.toContain("Project Rules");
  });

  it("includes AGENTS.md content under a heading when provided", () => {
    const prompt = buildSystemPrompt({
      agent: AGENTS.build,
      agentsMd: "Use TypeScript. No any.",
    });
    expect(prompt).toContain("## Project Rules (AGENTS.md)");
    expect(prompt).toContain("Use TypeScript. No any.");
  });

  it("places AGENTS.md between the agent prompt and the security rules", () => {
    const prompt = buildSystemPrompt({
      agent: AGENTS.build,
      agentsMd: "Project convention marker",
    });
    const agentIdx = prompt.indexOf("Tokenius");
    const projectIdx = prompt.indexOf("Project convention marker");
    const securityIdx = prompt.indexOf("## Security Rules");
    expect(agentIdx).toBeLessThan(projectIdx);
    expect(projectIdx).toBeLessThan(securityIdx);
  });

  it("is stable across calls with the same inputs (prompt-cache hit invariant)", () => {
    const args = { agent: AGENTS.build, agentsMd: "rules" };
    expect(buildSystemPrompt(args)).toBe(buildSystemPrompt(args));
  });

  it("differs per agent so build vs plan get distinct prompts", () => {
    const build = buildSystemPrompt({ agent: AGENTS.build });
    const plan = buildSystemPrompt({ agent: AGENTS.plan });
    expect(build).not.toBe(plan);
    expect(plan).toContain("CANNOT modify files");
  });
});
