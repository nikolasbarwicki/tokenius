// SKILL.md parser.
//
// Uses gray-matter for YAML frontmatter — handles quoting, nested types, and
// multi-line strings cleanly, which a hand-rolled `key: value` split wouldn't.
// The SKILL.md contract is tiny (`name`, `description`), but YAML leaves room
// to grow (e.g. `tools`, `model`) without another parser rewrite.
//
// Name validation: kebab-case, 1-64 chars. Folder name is the fallback when
// frontmatter omits `name`, so the regex catches bad folders and bad overrides
// alike.

import { readFileSync } from "node:fs";
import { basename, dirname } from "node:path";

import matter from "gray-matter";

import type { Skill } from "./types.ts";

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LENGTH = 64;

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

export function parseFrontmatter(source: string): ParsedFrontmatter {
  let result: matter.GrayMatterFile<string>;
  try {
    result = matter(source);
  } catch (error) {
    throw new Error(`Malformed frontmatter: ${(error as Error).message}`, { cause: error });
  }
  return {
    frontmatter: (result.data ?? {}) as Record<string, unknown>,
    body: result.content,
  };
}

export function parseSkill(path: string): Skill {
  const source = readFileSync(path, "utf8");
  const { frontmatter, body } = parseFrontmatter(source);

  const folderName = basename(dirname(path));
  const rawName = frontmatter.name ?? folderName;
  if (typeof rawName !== "string") {
    throw new TypeError(`Invalid skill name in ${path}: expected string, got ${typeof rawName}`);
  }
  if (rawName.length === 0 || rawName.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(rawName)) {
    throw new Error(
      `Invalid skill name "${rawName}" in ${path}: must be kebab-case and 1-${MAX_NAME_LENGTH} chars.`,
    );
  }

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

  return {
    name: rawName,
    description,
    content: body.trim(),
    path,
  };
}
