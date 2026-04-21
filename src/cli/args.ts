// CLI argument parser. Intentionally tiny: we support three boolean flags
// and bail out early for --version / --help. Real flag-parsing libs (commander,
// yargs) would be overkill — we're not building a multi-command CLI, and
// growing the surface gradually lets us see what ergonomics we actually need.
//
// `parseArgs` is pure (takes an argv slice) so the tests don't have to poke
// `process.argv`. `main()` in src/index.ts calls `parseArgs(process.argv.slice(2))`.

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

export const HELP_TEXT = `Tokenius — a streaming-first coding agent.

Usage:
  tokenius [options]

Options:
  -h, --help       Show this help and exit
  -v, --version    Print version and exit
      --debug      Log raw provider events + internal state to stderr
                   (same effect as DEBUG=tokenius)

In-session commands:
  /help            List available slash commands
  /sessions        List sessions in this project
  /load <id>       Replace current session with a saved one
  /cost            Show session cost so far
  /clear           Clear conversation history (keeps session file)
  /skills          List discovered skills in .tokenius/skills/
  /quit            Exit
`;
