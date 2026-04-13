# OpenCode Architecture Research

Research notes from exploring [opencode.ai/docs](https://opencode.ai/docs/) — an open-source AI coding agent with a client-server architecture (TUI + Web + IDE + SDK). Written in Go (server) + TypeScript (plugins/SDK).

---

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Client-Server Model](#client-server-model)
3. [Configuration System](#configuration-system)
4. [Providers & Models](#providers--models)
5. [Agents System](#agents-system)
6. [Tool System](#tool-system)
7. [Permissions](#permissions)
8. [Rules & Context (AGENTS.md)](#rules--context-agentsmd)
9. [Skills](#skills)
10. [Commands](#commands)
11. [MCP Servers](#mcp-servers)
12. [Plugin System](#plugin-system)
13. [Sessions & Compaction](#sessions--compaction)
14. [TUI & Keybindings](#tui--keybindings)
15. [CLI Modes](#cli-modes)
16. [SDK & API](#sdk--api)
17. [Formatters & LSP](#formatters--lsp)
18. [Key Patterns & Comparison with Pi](#key-patterns--comparison-with-pi)

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────┐
│  Clients: TUI / Web / IDE / SDK / ACP            │  ← Multiple simultaneous clients
├──────────────────────────────────────────────────┤
│           HTTP Server (OpenAPI 3.1)               │  ← Headless, port 4096
├──────────────────────────────────────────────────┤
│         Session Manager (fork/revert)             │  ← Stateful sessions
├──────────────────────────────────────────────────┤
│  Plugin System (hooks) + Extension Points         │  ← 30+ lifecycle hooks
├──────────────────────────────────────────────────┤
│       Agent Loop (primary + subagents)            │  ← Tool execution, steering
├──────────────────────────────────────────────────┤
│   Tool Registry (built-in + custom + MCP)         │  ← Permission-gated
├──────────────────────────────────────────────────┤
│   LLM Provider Abstraction (AI SDK + Models.dev)  │  ← 75+ providers
└──────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `opencode.json` / `opencode.jsonc` | Server/runtime config (schema: `https://opencode.ai/config.json`) |
| `tui.json` / `tui.jsonc` | TUI-specific config (schema: `https://opencode.ai/tui.json`) |
| `AGENTS.md` | Project rules/instructions (equiv. to Claude Code's `CLAUDE.md`) |
| `~/.local/share/opencode/auth.json` | Auth/token storage |

### Design Philosophy

- **Client-server separation** — headless server, any client can attach
- **OpenAPI-first** — full spec at `/doc`, SDK auto-generated
- **Compatibility** — reads `CLAUDE.md`, `.claude/skills/`, `.cursor/rules/` as fallbacks
- **Config merge, not replace** — 8-level config precedence
- **Permission-gated tools** — allow/ask/deny per tool with glob patterns

---

## Client-Server Model

Unlike Pi (which bundles everything into one process per mode), OpenCode separates server and client:

```
                    ┌─── TUI (terminal)
                    ├─── Web (browser via `opencode web`)
Server (port 4096) ─┼─── IDE (VS Code / Cursor / JetBrains)
                    ├─── SDK (programmatic Node.js client)
                    └─── ACP (stdio JSON-RPC for Zed, Neovim)
```

- **Multiple clients simultaneously** — e.g., TUI + IDE on same server
- **Attach to running server:** `opencode attach http://localhost:4096`
- **SSE event stream** at `/global/event` for real-time updates
- **Auth:** `OPENCODE_SERVER_PASSWORD` / `OPENCODE_SERVER_USERNAME` env vars

---

## Configuration System

### 8-Level Merge Precedence (lowest → highest)

1. Remote config (`.well-known/opencode`)
2. Global config (`~/.config/opencode/opencode.json`)
3. Custom config (`OPENCODE_CONFIG` env var)
4. Project config (`opencode.json`)
5. `.opencode` directories
6. Inline config (`OPENCODE_CONFIG_CONTENT` env var)
7. Managed config files
8. macOS managed preferences (`ai.opencode.managed`)

Configs **merge together** — not replaced. Variable substitution supported:

```json
{
  "provider": {
    "anthropic": {
      "api_key": "{env:ANTHROPIC_API_KEY}"
    }
  }
}
```

### Directory Structure

Uses plural subdirectory names under `.opencode/` or `~/.config/opencode/`:

```
.opencode/
  agents/        ← Agent definitions (.md or .json)
  commands/      ← Custom slash commands (.md)
  modes/         ← Agent modes
  plugins/       ← Plugin TypeScript files
  skills/        ← Skill folders with SKILL.md
  tools/         ← Custom tool definitions (.ts/.js)
  themes/        ← Custom theme JSON
```

### Core Config Sections

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {},          // LLM provider credentials + model options
  "model": "anthropic/claude-sonnet-4-5",
  "small_model": "anthropic/claude-haiku-4-5",
  "timeout": 300000,       // Overall timeout
  "chunkTimeout": 30000,   // Per-chunk streaming timeout
  "tools": {},             // Enable/disable/configure tools
  "agent": {},             // Agent definitions
  "default_agent": "build",
  "compaction": {},        // Auto-compact settings
  "mcp": {},               // MCP server configs
  "plugin": [],            // Plugin packages
  "instructions": [],      // Additional rule files
  "permission": {},        // Tool permission overrides
  "formatter": {},         // Auto-format on write
  "lsp": {},               // Language server configs
  "snapshot": {},          // File snapshot settings
  "share": {},             // Session sharing settings
  "watcher": {},           // File watcher settings
  "experimental": {}       // Experimental features
}
```

---

## Providers & Models

### 75+ Providers via AI SDK + Models.dev

Key providers: Anthropic, OpenAI, Google Vertex, Azure, Bedrock, Ollama, LM Studio, llama.cpp, DeepSeek, Groq, Together AI, Fireworks, OpenRouter, xAI.

### Model Format

`"provider_id/model_id"` — e.g., `"anthropic/claude-sonnet-4-5"`, `"openai/gpt-4o"`.

### Model Priority

```
CLI flag > config "model" > last used > first by internal priority
```

### Custom Providers (OpenAI-Compatible)

```json
{
  "provider": {
    "my-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "https://my-gateway.example.com/v1"
      },
      "api_key": "{env:MY_GATEWAY_KEY}",
      "models": {
        "my-model": {}
      }
    }
  }
}
```

### Provider-Specific Model Options

```json
{
  "provider": {
    "anthropic": {
      "models": {
        "claude-sonnet-4-5-20250929": {
          "options": {
            "thinking": { "type": "enabled", "budgetTokens": 16000 }
          }
        }
      }
    },
    "openai": {
      "models": {
        "gpt-5": {
          "options": { "reasoningEffort": "high", "textVerbosity": "low" }
        }
      }
    }
  }
}
```

### Built-in Thinking Variants

| Provider | Variants |
|----------|----------|
| Anthropic | `high`, `max` |
| OpenAI | `none`, `minimal`, `low`, `medium`, `high`, `xhigh` |
| Google | `low`, `high` |

Cycled via TUI keybinds.

**Comparison with Pi:** Pi implements its own unified `ThinkingLevel` enum (`minimal | low | medium | high | xhigh`) and maps per-provider. OpenCode delegates to AI SDK and uses provider-native variant names.

---

## Agents System

### Two Types

| Type | Purpose | Examples |
|------|---------|---------|
| **Primary agents** | Main assistants, cycled via Tab key | Build, Plan |
| **Subagents** | Specialized, invoked by primary agents or `@` mention | General, Explore |

### Built-in Agents

| Agent | Type | Tools | Purpose |
|-------|------|-------|---------|
| Build | Primary | All tools | Main coding agent |
| Plan | Primary | edit/bash restricted to "ask" | Planning, analysis |
| General | Subagent | Full tools | General-purpose subtask |
| Explore | Subagent | Read-only | Code exploration |
| Compaction | Hidden | None | Context summarization |
| Title | Hidden | None | Session title generation |
| Summary | Hidden | None | Session summary |

### Agent Configuration (JSON)

```json
{
  "agent": {
    "my-agent": {
      "description": "Security audit specialist",
      "mode": "primary",
      "model": "anthropic/claude-sonnet-4-5",
      "temperature": 0.3,
      "top_p": 0.9,
      "steps": 100,
      "prompt": "You are a security expert...",
      "color": "#ff6600",
      "permission": {
        "bash": "ask",
        "edit": "allow"
      },
      "tools": {
        "bash": true,
        "edit": true,
        "webfetch": false
      }
    }
  }
}
```

### Agent Configuration (Markdown)

File: `.opencode/agents/security-audit.md`

```markdown
---
description: Security audit specialist
mode: primary
model: anthropic/claude-sonnet-4-5
temperature: 0.3
steps: 100
permission:
  bash: ask
  edit: allow
tools:
  bash: true
  webfetch: false
---

You are a security expert. Focus on OWASP top 10 vulnerabilities...
```

**Comparison with Pi:** Pi uses an extension system to register "agents" as configurations. OpenCode makes agents a first-class config concept with dedicated directory, markdown frontmatter, and per-agent permission/model/tool overrides.

---

## Tool System

### Built-in Tools

| Tool | Purpose |
|------|---------|
| `bash` | Shell command execution with streaming output |
| `edit` | Modify existing files |
| `write` | Create/overwrite files |
| `read` | Read file contents |
| `grep` | Pattern search (ripgrep) |
| `glob` | File discovery by pattern |
| `list` | Directory listing |
| `lsp` | Language server queries (experimental) |
| `apply_patch` | Apply unified diffs |
| `skill` | Invoke a skill by name |
| `todowrite` | Manage task list |
| `webfetch` | Fetch web pages |
| `websearch` | Search the web (requires Exa API key) |
| `question` | Ask user a question |

### Custom Tools

TypeScript/JavaScript files in `.opencode/tools/` or `~/.config/opencode/tools/`:

```typescript
import { tool } from "@opencode-ai/plugin"

export default tool({
  description: "Query the project database",
  args: {
    query: tool.schema.string().describe("SQL query to execute"),
  },
  async execute(args, ctx) {
    // ctx: { agent, sessionID, messageID, directory, worktree }
    return `Executed query: ${args.query}`
  },
})
```

**Multiple tools per file** — named exports create `<filename>_<exportname>` tools:

```typescript
export const add = tool({
  description: "Add numbers",
  args: { a: tool.schema.number(), b: tool.schema.number() },
  execute: (args) => String(args.a + args.b),
})

export const multiply = tool({
  description: "Multiply numbers",
  args: { a: tool.schema.number(), b: tool.schema.number() },
  execute: (args) => String(args.a * args.b),
})
```

**Name collision:** Custom tools override built-in tools with same name.

### Tool Enable/Disable per Agent

```json
{
  "agent": {
    "explore": {
      "tools": {
        "bash": false,
        "edit": false,
        "write": false,
        "read": true,
        "grep": true,
        "glob": true
      }
    }
  }
}
```

**Comparison with Pi:** Pi uses a `createToolDefinitions()` factory with pluggable backends (interface injection for SSH/S3/containers). OpenCode uses a simpler file-based tool registration with the `@opencode-ai/plugin` helper. Pi has mandatory output truncation (2000 lines / 50KB) and dual buffer strategy for bash — OpenCode docs don't detail truncation internals.

---

## Permissions

### Three States

| State | Behavior |
|-------|----------|
| `allow` | Execute without asking |
| `ask` | Prompt user (options: once, always/session-scoped, reject) |
| `deny` | Block execution |

### Permission Scopes

`read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `skill`, `lsp`, `question`, `webfetch`, `websearch`, `codesearch`, `external_directory`, `doom_loop`

### Granular Rules with Glob Patterns

```json
{
  "permission": {
    "bash": {
      "git *": "allow",
      "bun test*": "allow",
      "rm *": "deny",
      "*": "ask"
    },
    "read": {
      "~/.ssh/*": "deny",
      ".env": "deny",
      "*": "allow"
    },
    "external_directory": "ask"
  }
}
```

**Last matching rule wins.** Wildcards: `*` (zero or more chars), `?` (one char). Home directory expansion (`~`, `$HOME`) supported.

### Defaults

- Most tools: `"allow"`
- `doom_loop`: `"ask"` (detects repeated failures)
- `external_directory`: `"ask"`
- `.env` files: `"deny"`

**Comparison with Pi:** Pi uses a `beforeToolCall` hook that returns `{ block: true, reason }`. OpenCode has a declarative, config-driven permission system with glob matching — no code needed. Pi's approach is more flexible (arbitrary logic), OpenCode's is more user-friendly (pure config).

---

## Rules & Context (AGENTS.md)

### File Precedence

1. **Local:** `AGENTS.md` (traverses upward from cwd to git root)
2. **Global:** `~/.config/opencode/AGENTS.md`
3. **Claude Code fallback:** `~/.claude/CLAUDE.md` (if no `AGENTS.md` found)

### Additional Instructions in Config

```json
{
  "instructions": [
    "CONTRIBUTING.md",
    "docs/guidelines.md",
    ".cursor/rules/*.md",
    "https://raw.githubusercontent.com/org/rules/main/style.md"
  ]
}
```

Supports: local files, glob patterns, remote URLs (5s timeout).

### Auto-Generation

`/init` command analyzes repo structure and generates `AGENTS.md`.

### Disable Claude Code Compatibility

```bash
OPENCODE_DISABLE_CLAUDE_CODE=1           # Disable all
OPENCODE_DISABLE_CLAUDE_CODE_PROMPT=1    # Global prompt file only
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1    # Skills only
```

---

## Skills

Reusable instruction sets loaded on-demand via the `skill` tool.

### Structure

```
.opencode/skills/
  react-migration/
    SKILL.md          # Frontmatter + instructions
    example-code.tsx  # Supporting files
```

### SKILL.md Format

```markdown
---
name: react-migration
description: "Guide through React migration strategies"
---

# React Migration Assistant
You are an expert at migrating legacy React codebases...
```

**Name constraints:** 1-64 chars, lowercase kebab-case, regex: `^[a-z0-9]+(-[a-z0-9]+)*$`

### Discovery Locations

- Project: `.opencode/skills/`, `.claude/skills/`, `.agents/skills/` (walks up to git root)
- Global: `~/.config/opencode/skills/`, `~/.claude/skills/`, `~/.agents/skills/`

### Permission Control

```json
{
  "permission": {
    "skill": {
      "react-migration": "allow",
      "dangerous-skill": "deny"
    }
  }
}
```

**Comparison with Pi:** Nearly identical concept. Both use `SKILL.md` with frontmatter. Pi lazy-loads skills when invoked via `/skill:name`. OpenCode uses the `skill` tool and supports broader discovery paths.

---

## Commands

Custom slash commands for repetitive prompts.

### Markdown File (`.opencode/commands/review.md`)

```markdown
---
description: "Code review with security focus"
agent: plan
model: anthropic/claude-sonnet-4-5
---

Review the following code for security issues.
Focus on OWASP top 10 vulnerabilities.

Context: $ARGUMENTS
File: @$1
```

### JSON Config

```json
{
  "command": {
    "review": {
      "template": "Review code for security: $ARGUMENTS\nFile: @$1",
      "description": "Security-focused code review",
      "agent": "plan",
      "subtask": false,
      "model": "anthropic/claude-sonnet-4-5"
    }
  }
}
```

### Template Features

| Syntax | Purpose |
|--------|---------|
| `$ARGUMENTS` | All arguments passed to command |
| `$1`, `$2`, `$3` | Positional arguments |
| `` !`command` `` | Shell output injection (runs at invocation) |
| `@filename` | File content embedding |

### Properties

- `template` (required) — the prompt text
- `description` — shown in help
- `agent` — force a specific agent
- `subtask` (boolean) — force subagent execution
- `model` — force a specific model

---

## MCP Servers

### Local Servers

```json
{
  "mcp": {
    "my-server": {
      "type": "local",
      "command": ["npx", "-y", "@my/mcp-server"],
      "environment": {
        "API_KEY": "{env:MY_API_KEY}"
      },
      "enabled": true,
      "timeout": 5000
    }
  }
}
```

### Remote Servers (with OAuth)

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.github.com/mcp",
      "headers": {
        "Authorization": "Bearer {env:GITHUB_TOKEN}"
      }
    },
    "oauth-service": {
      "type": "remote",
      "url": "https://service.example.com/mcp",
      "oauth": true
    }
  }
}
```

OAuth uses RFC 7591 Dynamic Client Registration. Tokens stored at `~/.local/share/opencode/mcp-auth.json`.

### Tool Management

MCP tool names are prefixed: `servername_toolname`. Glob-based enable/disable:

```json
{
  "mcp": {
    "github": {
      "type": "remote",
      "url": "https://api.github.com/mcp",
      "tools": {
        "github_create_issue": true,
        "github_delete_*": false
      }
    }
  }
}
```

### CLI Commands

```bash
opencode mcp add <name>      # Add server interactively
opencode mcp list            # List configured servers
opencode mcp auth <name>     # Authenticate to remote server
opencode mcp logout <name>   # Remove stored tokens
opencode mcp debug <name>    # Debug connection
```

---

## Plugin System

### Plugin Signature

```typescript
import type { Plugin } from "@opencode-ai/plugin"

export const MyPlugin: Plugin = async (ctx) => {
  // ctx: { project, directory, worktree, client, $ }
  // client = full SDK client
  // $ = Bun shell API

  return {
    "tool.execute.before": async (input) => {
      console.log(`Tool ${input.tool} called with`, input.args)
    },
    "tool.execute.after": async (input) => {
      console.log(`Tool ${input.tool} returned`, input.result)
    },
    "session.idle": async () => {
      // Agent finished, session is idle
    },
  }
}
```

### Loading

- **Local files:** `.opencode/plugins/` or `~/.config/opencode/plugins/`
- **NPM packages:** `"plugin": ["package-name"]` in config (auto-installed via Bun)
- **Dependencies:** Create `.opencode/package.json` → OpenCode runs `bun install` at startup

### Available Hooks (30+)

| Category | Hooks |
|----------|-------|
| **Commands** | `command.executed` |
| **Files** | `file.edited`, `file.watcher.updated` |
| **Installation** | `installation.updated` |
| **LSP** | `lsp.client.diagnostics`, `lsp.updated` |
| **Messages** | `message.part.removed`, `message.part.updated`, `message.removed`, `message.updated` |
| **Permissions** | `permission.asked`, `permission.replied` |
| **Server** | `server.connected` |
| **Sessions** | `session.created`, `session.compacted`, `session.deleted`, `session.diff`, `session.error`, `session.idle`, `session.status`, `session.updated` |
| **Todos** | `todo.updated` |
| **Shell** | `shell.env` |
| **Tools** | `tool.execute.before`, `tool.execute.after` |
| **TUI** | `tui.prompt.append`, `tui.command.execute`, `tui.toast.show` |
| **Experimental** | `experimental.session.compacting` (inject context or replace compaction prompts) |

### Logging

```typescript
await ctx.client.app.log({ level: "info", message: "Plugin loaded" })
```

### Community Plugins (30+)

Notable: sandbox isolation (Daytona), secret redaction (vibeguard), persistent memory (supermemory), workflow automation (conductor), desktop notifications, WakaTime tracking.

**Comparison with Pi:** Pi's extension system is a factory function that registers tools, commands, hooks, and event handlers. OpenCode's plugin system is more structured — return a hooks object, use SDK client for server interaction. Pi has richer in-process control (blocking, chaining, short-circuiting). OpenCode plugins operate through a client-server boundary.

---

## Sessions & Compaction

### Session Features

- Create, list, delete, fork, revert
- Fork = branch session at a specific message (like Pi's branching)
- Revert = undo last action
- Share = public URL at `opncd.ai/s/<id>`

### Compaction Config

```json
{
  "compaction": {
    "auto": true,        // Automatic compaction when context fills
    "prune": true,       // Prune old messages after compaction
    "reserved": 10000    // Reserved tokens for system + response
  }
}
```

### Session API (Server)

| Endpoint | Purpose |
|----------|---------|
| `POST /session` | Create session |
| `GET /session/:id` | Get session details |
| `DELETE /session/:id` | Delete session |
| `POST /session/:id/message` | Send message (blocking) |
| `POST /session/:id/prompt_async` | Send message (non-blocking) |
| `POST /session/:id/abort` | Stop execution |
| `POST /session/:id/fork` | Branch session at message |
| `POST /session/:id/share` | Enable sharing |

### Session Navigation (TUI)

- `Leader+Down` — first child branch
- `Right` — cycle child branches
- `Left` — cycle child reverse
- `Up` — parent message

**Comparison with Pi:** Pi stores sessions as append-only JSONL trees with `id`+`parentId` DAG structure, enabling branching without file duplication. Pi has a sophisticated cut-point detection algorithm that never cuts mid-tool-result and uses two-phase summarization. OpenCode's compaction details are less documented externally — the config is simpler (`auto`/`prune`/`reserved`) but internals aren't exposed.

---

## TUI & Keybindings

### Slash Commands

| Command | Purpose |
|---------|---------|
| `/connect` | Connect to MCP server |
| `/compact` | Compact context |
| `/details` | Show session details |
| `/editor` | Open external editor |
| `/exit` | Quit |
| `/export` | Export session |
| `/help` | Show help |
| `/init` | Generate AGENTS.md |
| `/models` | Switch model |
| `/new` | New session |
| `/redo` | Redo last action |
| `/sessions` | List sessions |
| `/share` | Share session |
| `/themes` | Switch theme |
| `/thinking` | Toggle thinking mode |
| `/undo` | Undo last action |
| `/unshare` | Remove sharing |

### Leader Key System

Default leader: `ctrl+x`. Most actions require leader then secondary key.

```json
{
  "keybinds": {
    "leader": "ctrl+x",
    "session_new": "<leader>n",
    "session_compact": "none",
    "model_list": "<leader>m"
  }
}
```

### 70+ Keybind Actions

Covers: app control, session management, message navigation (page up/down, first/last, copy, undo/redo), model selection, agent cycling, input editing (full readline/emacs-style), history, and terminal control.

### Themes

11+ built-in themes: `system`, `tokyonight`, `everforest`, `ayu`, `catppuccin`, `catppuccin-macchiato`, `gruvbox`, `kanagawa`, `nord`, `matrix`, `one-dark`.

Custom themes via JSON files in `.opencode/themes/` or `~/.config/opencode/themes/`.

---

## CLI Modes

### Core Commands

| Command | Purpose | Equivalent |
|---------|---------|------------|
| `opencode` | Interactive TUI | Pi's Interactive mode |
| `opencode run` | Non-interactive (stdin → stdout) | Pi's Print mode (`-p`) |
| `opencode serve` | Headless HTTP server | — (Pi has no separate server) |
| `opencode web` | Web UI | Pi's `pi-web-ui` package |
| `opencode attach` | Connect to running server | — |
| `opencode acp` | ACP protocol (stdio JSON-RPC) | Pi's RPC mode (`--mode rpc`) |

### Management Commands

```bash
opencode agent create/list       # Manage agents
opencode auth login/list/logout  # Authentication
opencode mcp add/list/auth       # MCP server management
opencode session list            # Session management
opencode models                  # List available models
opencode stats                   # Usage statistics
opencode export/import           # Session export/import
opencode github install/run      # GitHub integration
opencode upgrade                 # Self-update
```

### GitHub Integration

Bot responds to `/opencode` or `/oc` in issues/PRs. Runs in GitHub Actions.

**Comparison with Pi:** Pi has 4 modes sharing one `AgentSession` core (Interactive, Print, JSON, RPC). OpenCode separates into a server process + multiple client types. Pi's RPC is JSONL over stdin/stdout; OpenCode uses HTTP + SSE. OpenCode's approach enables multi-client scenarios (TUI + IDE on same session) that Pi's single-process model doesn't support.

---

## SDK & API

### Installation

```bash
npm install @opencode-ai/sdk
```

### Client Creation

```typescript
import { createOpencode } from "@opencode-ai/sdk"

// Auto-start server
const { client } = await createOpencode()

// Or connect to existing server
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://localhost:4096" })
```

### Core APIs

```typescript
// Health
await client.global.health()

// Sessions
const session = await client.session.create()
const result = await client.session.prompt({
  path: { id: session.id },
  body: { parts: [{ type: "text", text: "Hello" }] }
})
await client.session.abort({ path: { id: session.id } })

// Structured output
const structured = await client.session.prompt({
  path: { id: session.id },
  body: {
    parts: [{ type: "text", text: "Analyze this" }],
    format: {
      type: "json_schema",
      schema: {
        type: "object",
        properties: { score: { type: "number" } }
      }
    }
  }
})

// Search
await client.find.text({ body: { query: "TODO" } })
await client.find.files({ body: { query: "*.ts" } })
await client.find.symbols({ body: { query: "handleClick" } })

// Events (SSE)
client.event.subscribe((event) => {
  console.log(event.type, event.data)
})
```

### Server Endpoints

Full OpenAPI 3.1 spec at `http://localhost:4096/doc`:

| Path | Methods | Purpose |
|------|---------|---------|
| `/global/health` | GET | Health check |
| `/global/event` | GET | SSE event stream |
| `/project` | GET | Project info |
| `/config` | GET, PATCH | Configuration |
| `/session` | GET, POST | List/create sessions |
| `/session/:id` | GET, DELETE | Session CRUD |
| `/session/:id/message` | POST | Send message (blocking) |
| `/session/:id/prompt_async` | POST | Send message (non-blocking) |
| `/session/:id/abort` | POST | Stop execution |
| `/session/:id/fork` | POST | Branch session |
| `/find` | POST | Search files/text/symbols |
| `/file` | POST | Read file |
| `/agent` | GET | List agents |
| `/mcp` | GET | MCP status |

---

## Formatters & LSP

### Formatters

24+ built-in formatters (Biome, Prettier, Ruff, gofmt, rustfmt, etc.). Auto-format on write/edit.

Custom formatters:

```json
{
  "formatter": {
    "custom": {
      "command": ["my-formatter", "--fix", "$FILE"],
      "extensions": [".xyz"]
    }
  }
}
```

Disable all: `"formatter": false`.

### LSP Integration

30+ built-in language servers, auto-installed on first use.

```json
{
  "lsp": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "extensions": [".ts", ".tsx"],
      "env": {},
      "initialization": {}
    }
  }
}
```

Disable auto-download: `OPENCODE_DISABLE_LSP_DOWNLOAD=true`.

---

## Key Patterns & Comparison with Pi

### Architecture Comparison

| Aspect | Pi | OpenCode |
|--------|-----|----------|
| **Language** | TypeScript (96%) | Go (server) + TypeScript (plugins/SDK) |
| **Runtime** | Node.js | Go binary + Bun (plugins) |
| **Architecture** | Single process, multiple modes | Client-server (HTTP + SSE) |
| **Multi-client** | No (one mode at a time) | Yes (TUI + IDE + Web simultaneously) |
| **LLM Abstraction** | Custom unified stream function | AI SDK + Models.dev |
| **Provider Count** | ~6 (Anthropic, OpenAI, Google, Mistral, Bedrock) | 75+ via AI SDK |
| **Tool Definition** | TypeBox schema + execute function | Zod schema + `tool()` helper |
| **Tool Backends** | Pluggable operations (SSH/S3/container) | File-based, no backend abstraction |
| **Permissions** | Programmatic (`beforeToolCall` hook) | Declarative config (allow/ask/deny + globs) |
| **Extensions** | Factory function, in-process | Plugin files, client-server boundary |
| **Session Storage** | Append-only JSONL tree (id+parentId DAG) | Server-managed (details not public) |
| **Compaction** | 2-phase summarization, cut-point detection | Config-driven (auto/prune/reserved) |
| **RPC** | JSONL over stdin/stdout | HTTP REST + SSE |
| **TUI** | Custom framework (`pi-tui`, CSI 2026) | Built-in (Go-based) |
| **Config** | Settings JSON | 8-level merge with variable substitution |

### What OpenCode Does Better

1. **Client-server separation** — enables multi-client, IDE integration, programmatic SDK
2. **Declarative permissions** — no code needed, glob patterns, user-friendly
3. **Config system** — 8-level merge, variable substitution, managed preferences
4. **Provider breadth** — 75+ providers via AI SDK out of the box
5. **OpenAPI-first** — full spec, auto-generated SDK, structured output
6. **Community ecosystem** — 30+ plugins, GitHub bot, sharing
7. **Claude Code compatibility** — reads `CLAUDE.md`, `.claude/skills/` as fallbacks

### What Pi Does Better

1. **Streaming internals** — queue-and-waiter async iterator, partial JSON parsing, in-place message updates
2. **Tool execution model** — 3-phase parallel execution (prep → concurrent → sequential finalize)
3. **Session persistence** — append-only JSONL DAG with branching without file duplication
4. **Compaction sophistication** — cut-point detection, never cuts mid-tool-result, 2-phase summarization
5. **Backend abstraction** — pluggable operations for SSH/S3/containers
6. **Extension power** — in-process hooks can block, chain, short-circuit, transform context
7. **Output truncation** — mandatory dual limits (lines + bytes), metadata tells LLM to continue
8. **Single-package testing** — faux provider for unit tests without API calls

### Build Order Insight

If building from scratch (synthesized from both):

1. **LLM abstraction** — unified streaming, event types, provider registry
2. **Tool system** — schema, execute, permissions, truncation
3. **Agent loop** — inner/outer loops, tool execution, hooks
4. **Session/persistence** — storage, branching, compaction
5. **Config system** — merge layers, validation, variable substitution
6. **Server/API** — HTTP, SSE, OpenAPI spec
7. **CLI/TUI** — interactive mode, slash commands, themes
8. **Extensibility** — plugins, custom tools, MCP, skills
