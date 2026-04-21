// Tool-aware args preview. Lifted unchanged from the Sprint 6 renderer so the
// TUI can show the same signal on tool-call rows without reimplementing the
// switch. Generic JSON.stringify makes every tool look the same; keying on
// tool name keeps the signal high.

const ARGS_PREVIEW_MAX = 80;

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

function parseArgsRaw(raw: string): Record<string, unknown> {
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
