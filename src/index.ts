// Entry point — thin bootstrap that turns CLI args into a running REPL.
//
// Everything interesting lives in `src/cli/index.ts`. The only jobs here are:
//   1. Parse argv and short-circuit on --version / --help.
//   2. Flip on debug logging if --debug was passed.
//   3. Hand control to `runCLI`.
//
// Fatal errors bubble up here so the process can exit with a non-zero code
// and a single, readable message (instead of an uncaught promise stack).

import pc from "picocolors";

import { HELP_TEXT, parseArgs } from "./cli/args.ts";
import { runCLI } from "./cli/index.ts";
import { enableDebug } from "./debug.ts";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }

  if (args.version) {
    const pkg = (await Bun.file("package.json").json()) as { version: string };
    console.log(`tokenius v${pkg.version}`);
    return;
  }

  if (args.debug) {
    enableDebug();
  }

  await runCLI({ cwd: process.cwd() });
}

try {
  await main();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(pc.red(`\nError: ${message}`));
  process.exit(1);
}
