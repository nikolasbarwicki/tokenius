// CLI argument parser. Intentionally tiny: we support three boolean flags
// and bail out early for --version / --help. Real flag-parsing libs (commander,
// yargs) would be overkill — we're not building a multi-command CLI, and
// growing the surface gradually lets us see what ergonomics we actually need.
//
// `parseArgs` is pure (takes an argv slice) so the tests don't have to poke
// `process.argv`. `main()` in src/index.ts calls `parseArgs(process.argv.slice(2))`.

import { COMMAND_HELP } from "./commands.ts";

export interface CLIArgs {
  version: boolean;
  help: boolean;
  debug: boolean;
}

export function parseArgs(argv: readonly string[]): CLIArgs {
  return {
    version: argv.includes("--version") || argv.includes("-v"),
    help: argv.includes("--help") || argv.includes("-h"),
    debug: argv.includes("--debug"),
  };
}

function renderInSessionCommands(): string {
  const width = Math.max(...COMMAND_HELP.map(([name]) => name.length));
  return COMMAND_HELP.map(([name, desc]) => `  ${name.padEnd(width)}  ${desc}`).join("\n");
}

export const HELP_TEXT = `Tokenius — a streaming-first coding agent.

Usage:
  tokenius [options]

Options:
  -h, --help       Show this help and exit
  -v, --version    Print version and exit
      --debug      Log raw provider events + internal state to stderr
                   (same effect as DEBUG=tokenius)

In-session commands:
${renderInSessionCommands()}
`;
