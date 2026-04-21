/* oxlint-disable import/max-dependencies --
 * This file is deliberately the wiring hub where every layer meets. Splitting
 * the imports into a helper module would just trade one long import block for
 * two files that have to stay in sync. */
// Main CLI loop. This is the last non-trivial piece of composition in the
// codebase: it turns all the lower layers (provider, agent loop, session,
// skills, renderer, commands) into a working REPL.
//
// A few design points worth flagging for future-me:
//
//   * The system prompt is built ONCE per run and reused across turns. That's
//     the whole point of assembling it outside the `while` loop — Anthropic's
//     prompt cache can hit on every turn past the first. Mutating it per
//     turn would kill the cache and double the billable input tokens.
//
//   * The permission store lives at the REPL level, not inside `agentLoop`.
//     That way "allow for session" survives across turns AND across /load,
//     which is the natural mental model for users: the approvals apply to
//     *this shell session*, not *this conversation*.
//
//   * Title generation fires after the first assistant turn completes. It's
//     best-effort: `generateSessionTitle` swallows errors internally and
//     falls back to a truncated user message, and it's bounded by its own
//     timeout. We `await` it for simplicity — there's no user-visible benefit
//     to overlapping it with the next prompt, and a synchronous call keeps
//     session mutation ordered without needing a captured snapshot.
//
//   * Ctrl+C semantics:
//       - While the agent is running: abort the current loop.
//       - While idle at the prompt: single press is a no-op (prints a hint);
//         two presses within 1s exit the process.
//     This mirrors most shells and avoids losing work to a stray keypress.

import { createInterface } from "node:readline/promises";

import pc from "picocolors";

import { AGENTS } from "@/agent/agents.ts";
import { agentLoop } from "@/agent/loop.ts";
import { buildSystemPrompt } from "@/agent/system-prompt.ts";
import { loadAgentsMd } from "@/config/agents-md.ts";
import { MissingApiKeyError, resolveApiKey } from "@/config/api-keys.ts";
import { loadConfig } from "@/config/loader.ts";
import { debug } from "@/debug.ts";
import { createAnthropicProvider } from "@/providers/anthropic.ts";
import { calculateCost } from "@/providers/cost.ts";
import { createOpenAIProvider } from "@/providers/openai.ts";
import { registerProvider } from "@/providers/registry.ts";
import { createPermissionStore } from "@/security/permissions.ts";
import { appendMessage, createSession, setTitle } from "@/session/manager.ts";
import { generateSessionTitle } from "@/session/title.ts";
import { discoverSkills } from "@/skills/discovery.ts";
import { applySkill, parseSkillInvocation } from "@/skills/invoke.ts";

import { executeCommand } from "./commands.ts";
import { printBanner, printFirstRunHint, printMissingApiKey } from "./messages.ts";
import { createRenderer } from "./renderer.ts";

import type { Provider } from "@/providers/types.ts";
import type { Session } from "@/session/types.ts";
import type { Skill } from "@/skills/types.ts";
import type { UserMessage } from "@/types.ts";
import type { Interface as ReadlineInterface } from "node:readline/promises";

const PROMPT = pc.cyan("❯ ");

export interface RunCLIOptions {
  cwd: string;
}

export async function runCLI(options: RunCLIOptions): Promise<void> {
  const { cwd } = options;

  // --- Boot: config, API key, provider ---
  const config = loadConfig(cwd);
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      printMissingApiKey(error);
      // Exit cleanly instead of rethrowing — the top-level handler in
      // src/index.ts would add a generic "Error: …" wrapper that obscures
      // the nicely formatted block we just printed.
      process.exit(1);
    }
    throw error;
  }
  const provider: Provider = (() => {
    switch (config.provider) {
      case "anthropic":
        return createAnthropicProvider({ apiKey });
      case "openai":
        return createOpenAIProvider({
          apiKey,
          ...(config.baseUrl !== undefined && { baseUrl: config.baseUrl }),
        });
    }
  })();
  registerProvider(provider);

  // --- Boot: session + first-run hint ---
  const initial = createSession(cwd, config.model);
  if (initial.isFirstInProject) {
    printFirstRunHint(cwd);
  }
  let session: Session = initial.session;

  // --- Boot: skills, AGENTS.md, system prompt (built once!) ---
  const skills: Skill[] = discoverSkills(cwd);
  const agent = AGENTS.build;
  const agentsMd = loadAgentsMd(cwd);
  const systemPrompt = buildSystemPrompt({
    agent,
    agentsMd,
    skills,
  });

  // --- Boot: banner + renderer + persistent store ---
  printBanner(cwd, config.provider, config.model, session.id);
  const renderer = createRenderer({ model: config.model });
  const permissionStore = createPermissionStore();

  debug("cli", "startup", {
    provider: config.provider,
    model: config.model,
    cwd,
    skills: skills.map((s) => s.name),
    agentsMd: agentsMd ? `${agentsMd.length} chars` : "absent",
  });

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // --- Ctrl+C state ---
  let abortController = new AbortController();
  let agentRunning = false;
  let lastCtrlC = 0;

  process.on("SIGINT", () => {
    if (agentRunning) {
      process.stdout.write(pc.yellow("\n[aborting current turn]\n"));
      abortController.abort();
      return;
    }

    const now = Date.now();
    if (now - lastCtrlC < 1000) {
      process.stdout.write("\n");
      process.exit(0);
    }
    lastCtrlC = now;
    // Print the hint + a fresh prompt glyph so the user knows readline is
    // still waiting. We deliberately DON'T call `rl.prompt()` here: a
    // `rl.question()` is already in flight and `rl.prompt()` can leave the
    // internal readline state inconsistent (double prompt, dropped input).
    // Writing the glyph is cosmetic only — any typed input still goes to
    // the pending question.
    process.stdout.write(
      pc.dim("\n(press Ctrl+C again within 1s to exit, or type /quit)\n") + PROMPT,
    );
  });

  // --- Main loop ---
  //
  // Why not a for-each over `rl[Symbol.asyncIterator]()`? Because we need to
  // re-issue the prompt each iteration with re-wired state. A plain `while`
  // keeps the control flow legible.
  while (true) {
    const input = await readLine(rl);
    if (input === null) {
      // EOF (Ctrl+D). Treat as /quit.
      break;
    }
    if (input.trim().length === 0) {
      continue;
    }

    // --- Slash commands ---
    // `/skill:` looks like a slash command but is actually a user-message
    // prefix; route it to the skill branch below.
    if (input.startsWith("/") && parseSkillInvocation(input) === null) {
      const result = await executeCommand(input, {
        session,
        cwd,
        write: (s) => process.stdout.write(s),
      });
      if (result.type === "exit") {
        break;
      }
      if (result.type === "replace_session") {
        session = result.session;
      }
      continue;
    }

    // --- Skill invocation ---
    let userContent = input;
    const invocation = parseSkillInvocation(input);
    if (invocation) {
      if (invocation.name.length === 0) {
        process.stdout.write(pc.red("Usage: /skill:<name> <your request>. Try /skills.\n"));
        continue;
      }
      const skill = skills.find((s) => s.name === invocation.name);
      if (!skill) {
        process.stdout.write(pc.red(`Unknown skill: ${invocation.name}. Try /skills.\n`));
        continue;
      }
      userContent = applySkill(skill, invocation.prompt);
    }

    // --- Agent turn ---
    const userMsg: UserMessage = { role: "user", content: userContent };
    session.messages.push(userMsg);
    appendMessage(cwd, session.id, userMsg);

    abortController = new AbortController();
    agentRunning = true;
    const beforeCount = session.messages.length;

    let turnResult;
    try {
      turnResult = await agentLoop({
        agent,
        provider,
        model: config.model,
        messages: session.messages,
        systemPrompt,
        cwd,
        signal: abortController.signal,
        onEvent: renderer.handle,
        permissionStore,
      });
    } finally {
      agentRunning = false;
    }

    // Persist anything the loop appended (assistant + tool_result messages).
    // Contract with agentLoop: the returned `messages` array is the caller's
    // array extended with new turns — the first `beforeCount` entries are
    // identical to what we passed in. If that contract ever changes, this
    // slice will silently skip or duplicate messages.
    for (let i = beforeCount; i < turnResult.messages.length; i++) {
      const m = turnResult.messages[i];
      if (m !== undefined) {
        appendMessage(cwd, session.id, m);
      }
    }
    session.messages = turnResult.messages;

    // Per-turn footer (tokens + cost).
    const cost = calculateCost(config.model, turnResult.usage);
    renderer.printTurnFooter(turnResult.usage, cost);

    // Generate title on the first successful exchange.
    if (!session.header.title && turnResult.stopReason !== "error") {
      const title = await generateSessionTitle(input, provider, config.model);
      setTitle(cwd, session, title);
      debug("cli", "title", title);
    }
  }

  rl.close();
}

// --- Helpers ---

async function readLine(rl: ReadlineInterface): Promise<string | null> {
  try {
    return await rl.question(PROMPT);
  } catch (error) {
    // Readline throws on close / EOF — both of those end the REPL cleanly.
    // Log anything else via the debug channel so real failures aren't
    // completely silent when the user is running with `--debug`.
    debug("cli", "readline ended", error);
    return null;
  }
}
