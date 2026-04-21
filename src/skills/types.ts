// Skill — a named chunk of instructions the user can inject into a turn with
// `/skill:<name>`. Discovered from `.tokenius/skills/<name>/SKILL.md`.

export interface Skill {
  /** Kebab-case, 1-64 chars. Derived from folder name if frontmatter omits it. */
  name: string;
  description: string;
  /** Markdown body (everything after the frontmatter). */
  content: string;
  /** Absolute path to the SKILL.md file. */
  path: string;
}
