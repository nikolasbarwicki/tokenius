// Slash command dispatch for the CLI REPL.
//
// The REPL reads a line, and if it starts with `/` it's a command. Commands
// either mutate display state (print help, list sessions) or ask the REPL to
// do something structural (exit, replace the active session). That split is
// expressed by `CommandResult`: a tagged union the REPL pattern-matches on.
//
// Why keep commands outside the REPL loop? Two reasons:
//   1. They're pure-enough to test in isolation (just stub the write sink).
//   2. Future TUIs / transports (HTTP, Slack) can reuse this module without
//      rewriting the routing logic.
//
// Command state-changes that affect future persistence (/clear, /load) return
// a new `Session` rather than mutating the passed one, so the caller decides
// the order in which to swap it in.

import { existsSync } from "node:fs";
import { join } from "node:path";

import pc from "picocolors";

import { calculateCost } from "@/providers/cost.ts";
import { createSession, listSessions, loadSession } from "@/session/manager.ts";
import { discoverSkills } from "@/skills/discovery.ts";

import type { Session } from "@/session/types.ts";
import type { AssistantMessage, TokenUsage } from "@/types.ts";

export interface CommandContext {
  session: Session;
  cwd: string;
  /** Rendering sink — stdout in production, a buffer in tests. */
  write: (chunk: string) => void;
}

export type CommandResult =
  | { type: "none" }
  | { type: "exit" }
  | { type: "unknown"; name: string }
  | { type: "replace_session"; session: Session };

// Source of truth for in-session commands. `/exit` is accepted as an alias
// for `/quit` but intentionally not listed — a single canonical name keeps
// help output tidy.
export const COMMAND_HELP: readonly (readonly [string, string])[] = [
  ["/help", "Show this help"],
  ["/quit", "Exit tokenius"],
  ["/sessions", "List saved sessions in this project"],
  ["/load <id>", "Load a session (previous session stays on disk)"],
  ["/cost", "Show cumulative token cost for this session"],
  ["/clear", "Start a fresh session (previous one stays on disk)"],
  ["/skills", "List skills discovered in .tokenius/skills/"],
];

const AVAILABLE = COMMAND_HELP.map(([name]) => name.split(" ")[0]);

/**
 * Parse a raw input line (e.g. `/load abc123`) into a command name and the
 * rest of the string as its argument. Exported for tests and for distinguishing
 * slash-commands from prompts with a leading `/skill:` prefix.
 */
export function parseCommand(input: string): { name: string; arg: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }
  // `/skill:<name>` is NOT a slash command — it's a skill-invocation prefix
  // on a regular user message. Let the REPL handle it separately.
  if (trimmed.startsWith("/skill:")) {
    return null;
  }
  const spaceIdx = trimmed.indexOf(" ");
  if (spaceIdx === -1) {
    return { name: trimmed, arg: "" };
  }
  return { name: trimmed.slice(0, spaceIdx), arg: trimmed.slice(spaceIdx + 1).trim() };
}

// Keeping this async even though it doesn't currently `await` — the dispatch
// plane is where future commands (e.g. /model that talks to the registry,
// /replay that streams from disk) will naturally need async work. Making the
// signature async now means those additions don't force a caller-side refactor.
// oxlint-disable-next-line require-await
export async function executeCommand(input: string, ctx: CommandContext): Promise<CommandResult> {
  const parsed = parseCommand(input);
  if (!parsed) {
    return { type: "none" };
  }

  switch (parsed.name) {
    case "/help":
      return cmdHelp(ctx);
    case "/quit":
    case "/exit":
      return { type: "exit" };
    case "/sessions":
      return cmdSessions(ctx);
    case "/load":
      return cmdLoad(parsed.arg, ctx);
    case "/cost":
      return cmdCost(ctx);
    case "/clear":
      return cmdClear(ctx);
    case "/skills":
      return cmdSkills(ctx);
    default:
      ctx.write(pc.red(`Unknown command: ${parsed.name}\n`));
      ctx.write(pc.dim(`Available: ${AVAILABLE.join(", ")}\n`));
      return { type: "unknown", name: parsed.name };
  }
}

// --- Individual commands ---

function cmdHelp(ctx: CommandContext): CommandResult {
  const width = Math.max(...COMMAND_HELP.map(([name]) => name.length));
  const lines = [
    pc.bold("Available commands:"),
    ...COMMAND_HELP.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}`),
    "",
    pc.dim('Note: permission approvals ("allow for session") apply to this shell'),
    pc.dim("      process — they persist across /clear and /load."),
    pc.dim("Tip:  prefix a message with /skill:<name> to inject a skill's instructions."),
    "",
  ];
  ctx.write(`${lines.join("\n")}\n`);
  return { type: "none" };
}

function cmdSessions(ctx: CommandContext): CommandResult {
  const sessions = listSessions(ctx.cwd);
  if (sessions.length === 0) {
    ctx.write(pc.dim("No sessions yet in this project.\n"));
    return { type: "none" };
  }
  ctx.write(pc.bold(`Sessions in ${ctx.cwd}:\n`));
  for (const s of sessions) {
    const date = s.timestamp.slice(0, 16).replace("T", " ");
    ctx.write(
      `  ${pc.cyan(s.id)}  ${pc.dim(date)}  ${s.title} ${pc.dim(`(${s.messageCount} msgs)`)}\n`,
    );
  }
  return { type: "none" };
}

function cmdLoad(arg: string, ctx: CommandContext): CommandResult {
  if (!arg) {
    ctx.write(pc.red("Usage: /load <session-id>\n"));
    return { type: "none" };
  }

  // Guard against accidental wrong-project loads: `loadSession` only checks
  // file existence, so a typo produces an ENOENT. Friendlier to check first.
  const path = join(ctx.cwd, ".tokenius", "sessions", `${arg}.jsonl`);
  if (!existsSync(path)) {
    ctx.write(pc.red(`Session not found: ${arg}\n`));
    ctx.write(pc.dim("Use /sessions to list available session ids.\n"));
    return { type: "none" };
  }

  try {
    const session = loadSession(ctx.cwd, arg);
    ctx.write(
      pc.green(
        `Loaded session ${session.id} (${session.messages.length} messages${session.header.title ? `, "${session.header.title}"` : ""}).\n`,
      ),
    );
    return { type: "replace_session", session };
  } catch (error) {
    ctx.write(pc.red(`Failed to load session: ${(error as Error).message}\n`));
    return { type: "none" };
  }
}

function cmdCost(ctx: CommandContext): CommandResult {
  const totals: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let turns = 0;
  let toolCalls = 0;

  for (const msg of ctx.session.messages) {
    if (msg.role !== "assistant") {
      continue;
    }
    const assistant = msg as AssistantMessage;
    if (assistant.usage) {
      totals.inputTokens += assistant.usage.inputTokens;
      totals.outputTokens += assistant.usage.outputTokens;
      totals.cacheReadTokens =
        (totals.cacheReadTokens ?? 0) + (assistant.usage.cacheReadTokens ?? 0);
      totals.cacheWriteTokens =
        (totals.cacheWriteTokens ?? 0) + (assistant.usage.cacheWriteTokens ?? 0);
    }
    turns++;
    toolCalls += assistant.content.filter((b) => b.type === "tool_call").length;
  }

  const model = ctx.session.header.model;
  const cost = calculateCost(model, totals);

  ctx.write(`${pc.bold("Session cost")}\n`);
  ctx.write(`  Model:       ${model}\n`);
  ctx.write(`  Turns:       ${turns} (${toolCalls} tool calls)\n`);
  ctx.write(
    `  Tokens:      in ${totals.inputTokens.toLocaleString()} · out ${totals.outputTokens.toLocaleString()}`,
  );
  if (totals.cacheReadTokens || totals.cacheWriteTokens) {
    ctx.write(
      ` · cache r/w ${(totals.cacheReadTokens ?? 0).toLocaleString()}/${(totals.cacheWriteTokens ?? 0).toLocaleString()}`,
    );
  }
  ctx.write(`\n  Cost:        ${pc.green(`$${cost.toFixed(4)}`)}\n`);
  return { type: "none" };
}

function cmdClear(ctx: CommandContext): CommandResult {
  // Create a new session rather than zeroing messages in place — that way the
  // previous conversation stays on disk and can be re-loaded, and future
  // appends go to a clean file instead of polluting the old one.
  const { session } = createSession(ctx.cwd, ctx.session.header.model);
  ctx.write(pc.green(`Started new session ${session.id}.\n`));
  return { type: "replace_session", session };
}

function cmdSkills(ctx: CommandContext): CommandResult {
  const skills = discoverSkills(ctx.cwd);
  if (skills.length === 0) {
    ctx.write(pc.dim("No skills found in .tokenius/skills/.\n"));
    return { type: "none" };
  }
  ctx.write(pc.bold("Available skills:\n"));
  for (const s of skills) {
    ctx.write(`  ${pc.cyan(`/skill:${s.name}`)}${s.description ? ` — ${s.description}` : ""}\n`);
  }
  ctx.write(pc.dim("\nInvoke with /skill:<name> <your request>\n"));
  return { type: "none" };
}
