/* oxlint-disable import/max-dependencies --
 * The CLI entrypoint is intentionally the wiring hub. Splitting would trade
 * one import block for two files that have to stay in sync. */
// CLI bootstrap — composes config, provider, session, skills, and mounts the
// Ink app.
//
// The shape of this file is unchanged from Sprint 6/7: load config, resolve
// API key, build the system prompt once, print the banner, then hand off.
// The difference in Sprint 9 is the handoff — instead of a readline while-loop
// we `render(<App />)` and let React drive the REPL.

import { render } from "ink";
import React from "react";

import { AGENTS } from "@/agent/agents.ts";
import { buildSystemPrompt } from "@/agent/system-prompt.ts";
import { loadAgentsMd } from "@/config/agents-md.ts";
import { MissingApiKeyError, resolveApiKey } from "@/config/api-keys.ts";
import { loadConfig } from "@/config/loader.ts";
import { debug } from "@/debug.ts";
import { createAnthropicProvider } from "@/providers/anthropic.ts";
import { createOpenAIProvider } from "@/providers/openai.ts";
import { registerProvider } from "@/providers/registry.ts";
import { createPermissionStore } from "@/security/permissions.ts";
import { createSession } from "@/session/manager.ts";
import { discoverSkills } from "@/skills/discovery.ts";

import { printBanner, printFirstRunHint, printMissingApiKey } from "./messages.ts";
import { App } from "./tui/app.tsx";
import { createPromptBroker } from "./tui/prompter.ts";

import type { Provider } from "@/providers/types.ts";

export interface RunCLIOptions {
  cwd: string;
}

export async function runCLI(options: RunCLIOptions): Promise<void> {
  const { cwd } = options;

  const config = loadConfig(cwd);
  let apiKey: string;
  try {
    apiKey = resolveApiKey(config.provider);
  } catch (error) {
    if (error instanceof MissingApiKeyError) {
      printMissingApiKey(error);
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

  const initial = createSession(cwd, config.model);
  if (initial.isFirstInProject) {
    printFirstRunHint(cwd);
  }
  const session = initial.session;

  const skills = discoverSkills(cwd);
  const agent = AGENTS.build;
  const agentsMd = loadAgentsMd(cwd);
  const systemPrompt = buildSystemPrompt({ agent, agentsMd, skills });

  // Banner goes to stdout BEFORE Ink mounts so it stays in the terminal
  // scrollback above the React-managed region.
  printBanner(cwd, config.provider, config.model, session.id);

  const broker = createPromptBroker();
  const permissionStore = createPermissionStore();

  debug("cli", "startup", {
    provider: config.provider,
    model: config.model,
    cwd,
    skills: skills.map((s) => s.name),
    agentsMd: agentsMd ? `${agentsMd.length} chars` : "absent",
  });

  const { waitUntilExit } = render(
    React.createElement(App, {
      cwd,
      providerId: config.provider,
      provider,
      model: config.model,
      systemPrompt,
      session,
      skills,
      agent,
      broker,
      permissionStore,
    }),
  );

  await waitUntilExit();
}
