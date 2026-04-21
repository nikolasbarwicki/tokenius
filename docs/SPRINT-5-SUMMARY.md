# Sprint 5 Summary: Config & Skills

**Status:** Complete
**Milestone:** Project config, project rules, and skills all load and integrate with the agent. `buildSystemPrompt` now accepts a skills list; every piece Sprint 6's CLI needs at bootstrap and session start is in place.

---

## What Was Built

Sprint 5 delivers **Layer 7 (Skills)** and **Layer 8 (Configuration & Project Rules)** from the plan. Six small modules across two directories — no changes to the agent loop, providers, or session layers. The agent's system-prompt builder is the only existing file touched: it gained an optional `skills` parameter and a new "## Available Skills" section.

No CLI yet (Sprint 6) — all modules are pure library code. The Sprint 6 wiring pattern is documented at the end of this summary.

### Files Added

```
src/
├── config/
│   ├── loader.ts              # loadConfig — Zod + provider inference
│   ├── loader.test.ts         # defaults, merge, inference, invalid JSON, unknown model
│   ├── api-keys.ts            # resolveApiKey(provider) — env vars only
│   ├── api-keys.test.ts       # present / missing / empty per provider
│   ├── agents-md.ts           # loadAgentsMd — dumb passthrough
│   └── agents-md.test.ts      # present / missing / empty file
└── skills/
    ├── types.ts               # Skill interface
    ├── parser.ts              # parseFrontmatter (gray-matter) + parseSkill
    ├── parser.test.ts         # frontmatter, folder fallback, name validation, malformed YAML
    ├── discovery.ts           # discoverSkills — skip-and-warn on bad files
    ├── discovery.test.ts      # missing / empty / sorted / broken-skill skipped
    ├── invoke.ts              # applySkill (pure helper)
    └── invoke.test.ts         # prepend content, empty-prompt shortcut, trim
```

### Files Modified

```
src/agent/
├── system-prompt.ts           # +skills?: readonly Skill[] with "## Available Skills" section
└── system-prompt.test.ts      # +3 cases: omit / list / ordering between AGENTS.md and Security
```

### Dependencies Added

- `zod@^4` — strict schema validation for `tokenius.json`.
- `gray-matter@^4` — YAML frontmatter parsing for `SKILL.md`.

Both earn their keep: Zod gives typed parsing + strict-mode rejection of unknown keys with one `.strict()` call; gray-matter handles block scalars (`description: |`) and quoting edge cases a hand-rolled `key: value` splitter would get wrong.

---

## Architecture Decisions

### Config scope is `provider + model` only — for now

The plan's `TokeniusConfig` interface includes `maxTurns` and `permissions.bash/blockedPaths`. We implement only `provider` and `model` this sprint. Nothing consumes the other fields yet; carrying schema you don't read is a slow drift toward "why does this exist?" code. When Sprint 7 (Polish) wires permission rules into the bash tool gate, the schema grows alongside a real consumer. Until then, strict validation means a user who writes `permissions: {…}` today gets an error pointing at the unsupported key — honest feedback instead of silent no-op.

### Strict Zod schema rejects unknown keys

`.strict()` is a deliberate choice. A config typo like `provders: "anthropic"` otherwise becomes "use defaults and pretend everything's fine". Strict mode turns that into a startup error at the exact line the user wrote. The tradeoff is mechanical — Sprint 7 will need to extend the schema when it adds fields — but that's cheap. Silent misconfiguration is expensive.

### Provider is **inferred** from model, not cross-checked

The plan sketch validated `provider` and `model` separately. An earlier pass of this sprint did cross-check them — which produced surprising errors like _"Model 'gpt-5.4-mini' belongs to provider 'openai', but config provider is 'anthropic'"_ for a config that only said `{"model": "gpt-5.4-mini"}`. The user never wrote "anthropic"; that was our default.

The corrected design:

- **Only model set** → infer provider from the model's metadata (`getModelMetadata(model).provider`).
- **Both set and matching** → accept.
- **Both set and disagreeing** → throw, naming **both user-provided values** — never the default.
- **Neither set** → return `DEFAULT_CONFIG`.

Result: the error message only mentions values the user actually wrote. The model↔provider relationship is encoded in the metadata registry anyway; duplicating it in the config was always redundant.

### API keys — env vars only, no helper surface

`resolveApiKey(provider)` reads `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` and throws with the env var name on miss. There's no config-file key, no keychain integration, no "get the env var name" helper. An earlier pass exported `apiKeyEnvVar(provider)` "in case Sprint 6 wanted to show a missing-key prompt" — but the error message from `resolveApiKey` already includes the env var name, so the helper had no consumer. Deleted. One function, one contract.

### `AGENTS.md` is a dumb passthrough

`loadAgentsMd(cwd)` returns the file contents verbatim or `null`. No size cap, no parsing, no validation. The file is user-authored prose appended to the system prompt — any processing would be editorializing. Missing file returns `null` because it's the common case, not an error.

### Skills — discovered once per session

`discoverSkills(cwd)` runs **once at session start** and the resulting list feeds `buildSystemPrompt`. Edits to `SKILL.md` only take effect in new sessions. Two reasons:

1. **Cache hygiene.** The system prompt must be stable for the life of the session or prompt caching breaks. Re-discovering every turn would risk the catalog changing mid-session and invalidating the cached prefix.
2. **Consistency with `AGENTS.md`.** Same lifecycle: load at start, apply for the session, don't hot-reload.

Results are sorted by name — deterministic prompt prefix across runs.

### Skills: names in the prompt, bodies in the user message

The system prompt lists skills by `name + description` only. When the user invokes `/skill:<name>`, the **body** is prepended to the user message via `applySkill`. This keeps the cached prefix small regardless of how many skills exist — a 30-skill library doesn't bloat every turn, only the turn that actually uses one. It also sidesteps the "which skills should I proactively apply?" question: the user explicitly asks for one, we inject it, end of story.

### Skills fail soft, not loud

One malformed `SKILL.md` used to crash session startup for all skills. That's backwards: config (one file) earns fail-fast; user-authored skill libraries (N files, edited over time) should survive a single bad file. The corrected behavior: bad skills emit a `[tokenius] Skipping skill "<name>": <reason>` warning to stderr and the rest still load. Loud enough to notice, not loud enough to block work.

This is the opposite of the config decision, which is intentional — they're different trade-offs. One broken config file = your whole setup is wrong. One broken skill = one file is wrong while 29 others work.

### Name validation — kebab-case, 1-64 chars, same regex for folder and frontmatter

Folder name is the fallback when frontmatter omits `name`. A bad folder name and a bad override are structurally the same failure and get the same error. Single regex (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`), one length cap, one code path. Invalid names throw at parse time — which feeds into the fail-soft discovery path, so the broken skill is skipped rather than aborting.

### `applySkill` is pure

No filesystem, no lookups. The CLI (Sprint 6) parses `/skill:<name>` out of user input, finds the skill by name in the already-discovered list, and calls `applySkill(skill, userPrompt)`. Disk I/O happens **once** at session start; invocation stays synchronous and trivially testable.

### System prompt — skills between AGENTS.md and Security

Order matters for readability: agent persona → project rules → available tools-via-skills → security guardrails. Security is last so it's the most recent instruction the model sees — same as in Sprints 3-4.

---

## Key Implementations

### `loadConfig` — inference, not cross-check

```ts
const model = parsed.data.model ?? DEFAULT_CONFIG.model;
const modelProvider = getModelMetadata(model).provider;

if (parsed.data.provider && parsed.data.provider !== modelProvider) {
  throw new Error(
    `Model "${model}" belongs to provider "${modelProvider}", but tokenius.json sets provider to "${parsed.data.provider}".`,
  );
}

return { provider: modelProvider, model };
```

The error message mentions `parsed.data.provider` (the user-written string), never `DEFAULT_CONFIG.provider`. That's the detail that prevents the confusing "you wrote X but we think Y" class of error.

### `parseSkill` — same regex, two sources

```ts
const rawName = frontmatter.name ?? basename(dirname(path));
if (typeof rawName !== "string") throw new TypeError(/* ... */);
if (rawName.length === 0 || rawName.length > MAX_NAME_LENGTH || !NAME_PATTERN.test(rawName)) {
  throw new Error(
    `Invalid skill name "${rawName}" in ${path}: must be kebab-case and 1-${MAX_NAME_LENGTH} chars.`,
  );
}
```

The `typeof !== "string"` check is a `TypeError` (it's a type violation); the pattern/length check is an `Error` (it's a value violation). Small distinction, matches the lint rule, and makes the failure category visible to the catch site.

### `discoverSkills` — try/catch inside the loop

```ts
for (const entry of readdirSync(dir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const path = join(dir, entry.name, "SKILL.md");
  if (!existsSync(path)) continue;
  try {
    skills.push(parseSkill(path));
  } catch (error) {
    console.warn(`[tokenius] Skipping skill "${entry.name}": ${(error as Error).message}`);
  }
}
skills.sort((a, b) => a.name.localeCompare(b.name));
```

The sort runs after the loop — broken skills don't disturb ordering. Warnings go to `console.warn` so they land on stderr without dirtying stdout (which will become the renderer's territory in Sprint 6). The test uses `spyOn(console, "warn")` with `mockImplementation(() => {})` to silence and assert — no global state leaks between tests.

### `applySkill` — empty-prompt shortcut

```ts
export function applySkill(skill: Skill, userPrompt: string): string {
  const trimmed = userPrompt.trim();
  if (trimmed.length === 0) return skill.content;
  return `${skill.content}\n\n---\n\nUser request: ${trimmed}`;
}
```

If the user types `/skill:foo` with no follow-up text, we return the skill body alone rather than `Review thoroughly.\n\n---\n\nUser request: `. Cleaner output, and it's the user's way of saying "just run this skill".

### `buildSystemPrompt` — skills rendered between AGENTS.md and Security

```ts
function renderSkills(skills: readonly Skill[]): string {
  const lines = skills.map((s) =>
    s.description ? `- \`/skill:${s.name}\` — ${s.description}` : `- \`/skill:${s.name}\``,
  );
  return `## Available Skills\n\nThe user can invoke a skill by typing \`/skill:<name>\` in their message. When they do, the skill's instructions will be prepended to their request.\n\n${lines.join("\n")}`;
}
```

Skills without a description still render their invocation name — the line is informative on its own. The prompt text nudges the model to expect the `/skill:<name>` pattern so it doesn't get confused when a user message suddenly opens with a block of instructions followed by `User request:`.

---

## Test Coverage

**282 pass, 3 skip, 0 fail** across 32 test files (+42 pass, +6 files vs Sprint 4).

| Module                | What's covered                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `config/loader`       | defaults (no file, empty `{}`), partial merge, provider inference from model, explicit full config, invalid JSON             |
|                       | unknown provider rejected by Zod, unknown model rejected by metadata lookup, explicit mismatch, unknown keys (`strict` mode) |
| `config/api-keys`     | `resolveApiKey` for both providers present, both missing, empty string treated as missing                                    |
| `config/agents-md`    | missing file → `null`, present → verbatim contents, empty file → empty string                                                |
| `skills/parser`       | `parseFrontmatter`: inline key/value, block scalar multi-line, no delimiters, malformed YAML throws                          |
|                       | `parseSkill`: frontmatter name/description, folder fallback, uppercase/underscore rejected, non-string description ignored   |
| `skills/discovery`    | missing dir / empty dir → `[]`, directories without `SKILL.md` skipped, non-dir entries skipped, sorted by name              |
|                       | **broken skill skipped with stderr warning + good skills still returned** (the fail-soft invariant)                          |
| `skills/invoke`       | prepend content to prompt with separator, empty prompt returns content alone, whitespace-only prompt treated as empty        |
| `agent/system-prompt` | skills section omitted when absent/empty, listed with `/skill:name` and description, ordered between AGENTS.md and Security  |

No integration test wires config → provider → agent yet; that composition lands in Sprint 6's CLI bootstrap. Each module is individually covered; the composition is trivial enough that an end-to-end test would mostly duplicate what's already verified.

---

## Divergences from PLAN.md (now reconciled)

PLAN.md has been updated. The main changes:

- **Skills section added to `buildSystemPrompt`.** The file's own Sprint 3 comment foreshadowed this; it's now implemented. New optional `skills?: readonly Skill[]` parameter renders "## Available Skills" between AGENTS.md and Security.
- **Discovery is fail-soft, not fail-loud.** Plan's sketch would have propagated a parse error out of `discoverSkills` and killed startup. New behavior: warn and skip, so one broken skill can't hold all the others hostage.
- **`parseFrontmatter` uses `gray-matter`.** Plan's hand-rolled regex + `key: value` split would miss block scalars and mishandle quoting. Replaced with a proper YAML parser via the `gray-matter` dep.
- **Skill name validation is strict.** Kebab-case regex + 1-64 char cap, applied uniformly to folder fallback and frontmatter override. Plan left names un-validated.
- **`invokeSkill(name, prompt, cwd)` → `applySkill(skill, prompt)`.** Plan coupled discovery + application in one call. Split into (a) discovery once per session and (b) a pure `applySkill` helper. The `/skill:<name>` parsing lives in the CLI in Sprint 6, not here.
- **Config scope is `provider + model` only.** `maxTurns` and `permissions` are deferred until they have consumers (Sprint 7). Adding them now would mean a live schema field no code reads.
- **Config validation uses Zod in `strict()` mode.** Plan's hand-rolled `if (!MODELS[...])` is replaced with schema parsing + metadata lookup. Strict mode rejects unknown keys to catch typos.
- **Provider is inferred from model, not cross-checked.** When the user omits `provider`, we derive it from the model's metadata. When both are set and disagree, the error names only user-provided values. Prevents confusing defaults-based error messages.
- **`resolveApiKey` has no `apiKeyEnvVar` sibling.** Single function. Error message includes the env var name on miss.

---

## How It Connects to Sprint 6

The CLI bootstrap (Sprint 6) calls these six modules in a fixed order:

```ts
// At process start
const config = loadConfig(cwd); // 5.1
const apiKey = resolveApiKey(config.provider); // 5.2
const provider = createProvider(config.provider, apiKey);

// At session start (once)
const agentsMd = loadAgentsMd(cwd); // 5.3
const skills = discoverSkills(cwd); // 5.4 + 5.5
const systemPrompt = buildSystemPrompt({
  agent: AGENTS.build,
  agentsMd,
  skills,
});

// Per user turn
const input = await readline();
const invoked = input.match(/^\/skill:([\w-]+)(?:\s+(.*))?$/s);
const userContent = invoked
  ? applySkill(
      // 5.6
      skills.find((s) => s.name === invoked[1]) ?? throw_(/* unknown skill */),
      invoked[2] ?? "",
    )
  : input;
session.messages.push({ role: "user", content: userContent });
// … existing loop from Sprint 3-4 …
```

Discovery is called **once per session** (not per turn) — the resulting list stays in scope for the CLI's main loop and feeds every `/skill:<name>` lookup without touching the disk again. The system prompt is built **once** from the same list, so what the model sees in the catalog matches what the user can invoke.

A typo like `/skill:revuew` surfaces immediately at the CLI layer with a "Unknown skill" message (Array.find returns undefined). Malformed skill files never reach this path — they were already filtered out by `discoverSkills` with a stderr warning at session start.

---

## Running It

```bash
# All tests (282 pass, 3 skip)
bun test

# Full check suite (lint, format, typecheck, knip, test)
bun run check

# Smoke test the provider layer (needs ANTHROPIC_API_KEY)
bun run src/smoke.ts
```

Still no interactive CLI — Sprint 6. Every Sprint 5 module is pure library code with its own test file. Sprint 6 is now unblocked: config loads at bootstrap, `AGENTS.md` + skills load at session start, `applySkill` runs per-invocation. The entire Layer 7-8 surface area is ~200 lines of implementation.
