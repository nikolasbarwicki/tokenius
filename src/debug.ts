// Debug logging. Goes to stderr so it never corrupts streamed assistant text
// on stdout. Two activation paths:
//   - `--debug` CLI flag  → handled by `enableDebug()` in the entry point
//   - `DEBUG=tokenius` env → auto-detected on module load
//
// The module-level `enabled` flag is mutable deliberately. CLI bootstrap calls
// `enableDebug()` after parsing argv; `debug(...)` everywhere else is a pure
// no-op until then. Keeping this in one tiny module avoids circular imports
// between providers/tools/agent — anything can depend on it.

let enabled = process.env["DEBUG"] === "tokenius";

export function enableDebug(): void {
  enabled = true;
}

export function isDebugEnabled(): boolean {
  return enabled;
}

export function debug(category: string, ...args: unknown[]): void {
  if (!enabled) {
    return;
  }
  // HH:MM:SS.mmm — enough resolution to order events within a turn without
  // the noise of a full ISO timestamp.
  const ts = new Date().toISOString().slice(11, 23);
  console.error(`[${ts}] [${category}]`, ...args);
}
