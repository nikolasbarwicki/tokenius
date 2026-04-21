# Tokenius Roadmap

Trackable checklist derived from [PLAN.md](./PLAN.md). Each sprint produces a working, testable increment.

---

## Sprint 1: Foundation

**Milestone:** Can send a prompt to Claude and stream the response to the terminal.

- [x] 1.1 Define all core types in `src/types.ts`
- [x] 1.2 Model metadata in `src/providers/models.ts` — test: `getModelMetadata` known + unknown
- [x] 1.3 Cost calculation in `src/providers/cost.ts` — test: `calculateCost`, `addUsage`
- [x] 1.4 Provider types in `src/providers/types.ts`
- [x] 1.5 Anthropic provider in `src/providers/anthropic.ts` — fix: merge input tokens from `message_start` + output tokens from `message_delta` into `message_end` usage; includes cache token forwarding
- [x] 1.6 Provider registry in `src/providers/registry.ts`
- [x] 1.7 Retry logic in `src/providers/retry.ts` — test: `isRetryable` unit tests
- [x] 1.8 Partial JSON parser in `src/providers/partial-json.ts` — test: extensive edge cases
- [x] 1.9 Smoke test — hardcoded prompt, stream to stdout

## Sprint 2: Tools + Security

**Milestone:** All 6 core tools work with security enforced. Can read, write, search, and execute.

- [x] 2.1 Tool types in `src/tools/types.ts`
- [x] 2.2 Tool registry in `src/tools/registry.ts` — test: schema sorting determinism
- [x] 2.3 Truncation in `src/tools/truncation.ts` — test: head/tail, limits, mid-line safety
- [x] 2.4 Arg validation in `src/tools/validation.ts` — test: valid, missing required, wrong type
- [x] 2.5 Path validation in `src/security/path-validation.ts` — test: within cwd, outside, blocked files/dirs
- [x] 2.6 Secrets detection in `src/security/secrets-detection.ts` — test: API keys, tokens, false positives
- [x] 2.7 Command detection in `src/security/command-detection.ts` — test: safe, blocked, confirmation patterns
- [x] 2.8 `read` tool — test: read file, offset/limit, binary, blocked path
- [x] 2.9 `grep` tool — test: pattern match, include filter, rg fallback
- [x] 2.10 `glob` tool — test: pattern match, sorted output
- [x] 2.11 `bash` tool — test: execution, timeout kill, blocked command
- [x] 2.12 `write` tool — test: create, overwrite, mkdir -p, blocked secret
- [x] 2.13 `edit` tool — test: unique match, no match, multi-match, replace_all

## Sprint 3: Agent Loop

**Milestone:** Agent loop works end-to-end. Tool calls, security, context tracking all wired together.

- [x] 3.1 Context tracker in `src/agent/context-tracker.ts` — test: `isContextExhausted`, `estimateTokens`
- [x] 3.2 Stream accumulator in `src/agent/stream.ts` — test: events to AssistantMessage assembly
- [x] 3.3 Tool execution in `src/agent/execute.ts` — test: validation errors, permission denied, sequential
- [x] 3.4 Permission prompts in `src/security/permissions.ts` — test: batch prompting, session memory
- [x] 3.5 Agent loop in `src/agent/loop.ts` — test: termination, tool exec, context limit, abort
- [x] 3.6 Agent configs in `src/agent/agents.ts`
- [x] 3.7 System prompt builder in `src/agent/system-prompt.ts` — test: with/without AGENTS.md, with/without skills
- [x] 3.8 `spawn_agent` tool in `src/tools/spawn-agent.ts` — test: subagent invocation, cost display
- [x] 3.9 End-to-end test with mock provider — full loop: user msg, tools, response, session

## Sprint 4: Persistence

**Milestone:** Sessions persist to disk and can be loaded back.

- [x] 4.1 Session types in `src/session/types.ts`
- [x] 4.2 Session manager in `src/session/manager.ts` — test: create, append, load roundtrip, list, sort
- [x] 4.3 Session title generation in `src/session/title.ts` — test: `truncateForTitle`, stream accumulation, sanitize, abort/error fallback
- [x] 4.4 First-run `.gitignore` hint — detected via `isFirstInProject` from `createSession`; the hint text is inlined in the CLI in Sprint 6

## Sprint 5: Config & Skills

**Milestone:** Config, project rules, and skills all load and integrate with the agent.

- [ ] 5.1 Config loader in `src/config/loader.ts` — test: default, valid, invalid provider, unknown model
- [ ] 5.2 API key resolution in `src/config/api-keys.ts` — test: present, missing
- [ ] 5.3 AGENTS.md loader in `src/config/agents-md.ts` — test: present, missing
- [ ] 5.4 Skill parser in `src/skills/parser.ts` — test: with frontmatter, without, malformed
- [ ] 5.5 Skill discovery in `src/skills/discovery.ts` — test: directory with skills, empty, missing
- [ ] 5.6 Skill invocation — `/skill:name` prepends content

## Sprint 6: CLI

**Milestone:** Fully functional CLI. Can have real conversations with the agent.

- [ ] 6.1 CLI args parser in `src/cli/args.ts` — test: `--version`, `--help`, `--debug`
- [ ] 6.2 Streaming renderer in `src/cli/renderer.ts`
- [ ] 6.3 Context window indicator
- [ ] 6.4 Slash commands in `src/cli/commands.ts`
- [ ] 6.5 Debug mode in `src/debug.ts`
- [ ] 6.6 Main CLI loop in `src/cli/index.ts`
- [ ] 6.7 Bootstrap in `src/index.ts`
- [ ] 6.8 Startup banner (model, provider, cwd, session ID)

## Sprint 7: Polish

**Milestone:** Production-quality CLI with two providers and polished error handling.

- [ ] 7.1 OpenAI provider in `src/providers/openai.ts`
- [ ] 7.2 `/usage` command (detailed stats)
- [ ] 7.3 `/replay` command
- [ ] 7.4 Error handling pass — network, empty responses, abort
- [ ] 7.5 Missing ripgrep graceful fallback
- [ ] 7.6 First-run experience — missing API key message

## Sprint 8: Documentation & CI

**Milestone:** Portfolio-ready. Anyone can clone, install, use, and understand the design.

- [ ] 8.1 GitHub Actions CI workflow (`.github/workflows/ci.yml`)
- [ ] 8.2 Branch protection on `main`
- [ ] 8.3 `package.json` — bin, files, keywords, description
- [ ] 8.4 README.md — pitch, architecture diagram, install, quick start
- [ ] 8.5 Terminal demo recording (vhs or asciinema)
- [ ] 8.6 `docs/DECISIONS.md` — all design decision entries

## Sprint 9: TUI (future)

**Milestone:** Rich terminal UI with visual feedback.

- [ ] 9.1 Choose TUI framework (Ink or custom)
- [ ] 9.2 Spinners during LLM response + tool execution
- [ ] 9.3 Syntax highlighting for code blocks
- [ ] 9.4 Split view (input bottom, output scrolling top)
- [ ] 9.5 Permission confirmation dialogs as proper UI
