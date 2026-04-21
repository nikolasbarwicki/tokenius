// Streaming renderer: AgentEvent → terminal output.
//
// The agent loop is UI-agnostic — it emits events and this module decides how
// to display them. That separation is what makes the TUI upgrade in Sprint 9
// a pure rewrite of this file instead of a cross-cutting change.
//
// Design notes:
//   - `createRenderer` returns a closure holding per-turn state. This is where
//     the tool-call → tool-result pairing lives: we queue pending calls on
//     `tool_call_start` / `tool_call_args`, then dequeue on `tool_result` to
//     render `> name   <preview>` + outcome atomically.
//   - Args preview is intentionally tool-aware. Generic `JSON.stringify` is
//     noisy for bash commands and loses intent for spawn_agent. A switch keyed
//     on tool name stays readable and is easy to extend when new tools land.
//   - Writes go through an injected `write` callback so tests can assert the
//     produced text without touching process.stdout.
//
// The tool-call → result pairing assumes tools execute in the order they were
// called (enforced by `executeToolsSequential`). If that ever changes, this
// renderer needs a correlation id.

import pc from "picocolors";

import { getModelMetadata } from "@/providers/models.ts";

import type { AgentEvent, AgentEventHandler } from "@/agent/types.ts";

const ARGS_PREVIEW_MAX = 80;
const ERROR_PREVIEW_MAX = 200;

interface PendingCall {
  name: string;
  rawArgs: string;
}

export interface RendererOptions {
  /** Model id, used to compute context-window percentage on turn_end. */
  model: string;
  /** Sink for rendered output. Defaults to stdout; tests inject a buffer. */
  write?: (chunk: string) => void;
}

export interface Renderer {
  handle: AgentEventHandler;
  /** Print the per-turn usage line (tokens + cost). Called by the main loop. */
  printTurnFooter: (usage: { inputTokens: number; outputTokens: number }, cost: number) => void;
}

export function createRenderer(options: RendererOptions): Renderer {
  const write = options.write ?? ((s: string) => process.stdout.write(s));
  const contextWindow = getModelMetadata(options.model).contextWindow;

  // FIFO queue: new calls are pushed at the end; tool_result dequeues the
  // head. Multiple tool calls per turn are stored in order.
  const pending: PendingCall[] = [];

  function handle(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        // No output — turns don't need a visible marker in the happy path.
        break;

      case "text_delta":
        write(event.text);
        break;

      case "thinking_delta":
        // Dim so it's visually distinct from the final answer.
        write(pc.dim(event.thinking));
        break;

      case "tool_call_start":
        pending.push({ name: event.name, rawArgs: "" });
        break;

      case "tool_call_args": {
        // `partialArgs` is the accumulated raw string so far — we just
        // replace, never concatenate. Always updates the most recently
        // started call (the one still receiving deltas).
        const last = pending.at(-1);
        if (last) {
          last.rawArgs = event.partialArgs;
        }
        break;
      }

      case "tool_result": {
        const call = pending.shift();
        const name = call?.name ?? event.name;
        const preview = call ? previewArgs(name, call.rawArgs) : "";
        write(`\n${pc.cyan(`→ ${name}`)}`);
        if (preview) {
          write(`  ${pc.dim(preview)}`);
        }
        write("\n");

        if (event.result.isError) {
          const snippet = event.result.content.slice(0, ERROR_PREVIEW_MAX);
          write(`  ${pc.red(`✖ ${snippet}`)}\n`);
        } else {
          const len = event.result.content.length;
          write(`  ${pc.green(`✓ ${len.toLocaleString()} chars`)}\n`);
        }
        break;
      }

      case "turn_end": {
        // Context indicator goes here so it's visible after every exchange.
        // `usage.inputTokens` is the authoritative count from the provider;
        // see providers/anthropic.ts for how it's assembled.
        write(`\n${formatContextIndicator(event.usage.inputTokens, contextWindow)}\n`);
        break;
      }

      case "context_limit_reached":
        write(pc.yellow("\nSession context full. Start a new session or use /clear to reset.\n"));
        break;

      case "turn_limit_reached":
        write(pc.yellow(`\nReached turn limit (${event.maxTurns}). Stopping.\n`));
        break;

      case "subagent_complete":
        write(
          pc.dim(
            `\n↳ ${event.agent} done (${event.turns} turns, ${event.tokens.toLocaleString()} tokens, $${event.cost.toFixed(4)})\n`,
          ),
        );
        break;

      case "error":
        write(pc.red(`\nError: ${event.error.message}\n`));
        break;
    }
  }

  function printTurnFooter(
    usage: { inputTokens: number; outputTokens: number },
    cost: number,
  ): void {
    const total = usage.inputTokens + usage.outputTokens;
    write(pc.dim(`${total.toLocaleString()} tokens · $${cost.toFixed(4)}\n`));
  }

  return { handle, printTurnFooter };
}

/**
 * Produce a one-line preview of tool arguments for display.
 *
 * Tool-specific extraction keeps the signal high:
 *   - bash → the command being run
 *   - read/write/edit → the file path
 *   - grep/glob → the search pattern
 *   - spawn_agent → agent name + first chunk of the prompt
 *
 * Falls back to a truncated JSON dump for unknown tools. Exported for testing.
 */
export function previewArgs(name: string, rawArgs: string): string {
  const args = parseArgsRaw(rawArgs);

  switch (name) {
    case "bash":
      return truncate(firstLine(String(args["command"] ?? "")), ARGS_PREVIEW_MAX);
    case "read":
    case "write":
    case "edit":
      return String(args["path"] ?? "");
    case "grep":
    case "glob":
      return String(args["pattern"] ?? "");
    case "spawn_agent": {
      const agent = String(args["agent"] ?? "");
      const prompt = truncate(String(args["prompt"] ?? ""), 60);
      return agent && prompt ? `${agent}: ${prompt}` : agent || prompt;
    }
    default:
      return truncate(rawArgs.replaceAll(/\s+/g, " "), ARGS_PREVIEW_MAX);
  }
}

/**
 * Color-coded context indicator. Green < 50%, yellow < 80%, red beyond.
 * Exported for tests that want to assert threshold transitions.
 */
export function formatContextIndicator(usedTokens: number, windowTokens: number): string {
  const pct = windowTokens > 0 ? (usedTokens / windowTokens) * 100 : 0;
  const used = Math.round(usedTokens / 1000);
  const total = Math.round(windowTokens / 1000);
  const label = `[${used}k / ${total}k tokens · ${Math.round(pct)}%]`;

  const color = pickColor(pct);
  return color(label);
}

// --- internal helpers ---

function pickColor(pct: number): (s: string) => string {
  if (pct < 50) {
    return pc.green;
  }
  if (pct < 80) {
    return pc.yellow;
  }
  return pc.red;
}

function parseArgsRaw(raw: string): Record<string, unknown> {
  // Best-effort. The stream-accumulator uses parsePartialJson on completion;
  // here we only preview during/after streaming so a failed parse means "not
  // enough data yet" and we render an empty preview rather than throwing.
  try {
    const value = JSON.parse(raw) as unknown;
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function firstLine(s: string): string {
  const nl = s.indexOf("\n");
  return nl === -1 ? s : `${s.slice(0, nl)} ⏎`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
