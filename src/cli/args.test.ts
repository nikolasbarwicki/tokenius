import { describe, expect, it } from "bun:test";

import { parseArgs } from "./args.ts";

describe("parseArgs", () => {
  it("returns all false for an empty argv", () => {
    expect(parseArgs([])).toEqual({ version: false, help: false, debug: false });
  });

  it("detects --version and its short form -v", () => {
    expect(parseArgs(["--version"]).version).toBe(true);
    expect(parseArgs(["-v"]).version).toBe(true);
  });

  it("detects --help and its short form -h", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
    expect(parseArgs(["-h"]).help).toBe(true);
  });

  it("detects --debug (no short form)", () => {
    expect(parseArgs(["--debug"]).debug).toBe(true);
    expect(parseArgs(["-d"]).debug).toBe(false);
  });

  it("handles multiple flags together", () => {
    expect(parseArgs(["--debug", "--help"])).toEqual({
      version: false,
      help: true,
      debug: true,
    });
  });

  it("ignores unknown flags silently", () => {
    // Unknown flags are not an error — parseArgs returns only what it knows
    // about. The main entry point can decide whether to complain.
    expect(parseArgs(["--nonsense", "positional"])).toEqual({
      version: false,
      help: false,
      debug: false,
    });
  });
});
