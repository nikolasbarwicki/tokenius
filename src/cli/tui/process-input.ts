// Turn a user input line into actions + an agent-loop invocation.
// Extracted from app.tsx so the component file stays under the lint limit
// and so this flow is testable on its own (it's pure async logic — no React).
//
// Flow:
//   1. Slash command?  → run executeCommand, buffer its output, dispatch as
//                         a single system_message block, handle exit/replace.
//   2. /skill: prefix? → look up the skill, wrap the prompt via applySkill.
//   3. Otherwise       → append user message, call agentLoop, persist results,
//                         dispatch turn_finished with usage + cost, generate
//                         the session title on first successful turn.

import { agentLoop } from "@/agent/loop.ts";
import { calculateCost } from "@/providers/cost.ts";
import { appendMessage, setTitle } from "@/session/manager.ts";
import { generateSessionTitle } from "@/session/title.ts";
import { applySkill, parseSkillInvocation } from "@/skills/invoke.ts";

import { executeCommand } from "../commands.ts";

import type { PromptBroker } from "./prompter.ts";
import type { Action } from "./store-types.ts";
import type { AgentConfig } from "@/agent/types.ts";
import type { Provider } from "@/providers/types.ts";
import type { PermissionStore } from "@/security/permissions.ts";
import type { Session } from "@/session/types.ts";
import type { Skill } from "@/skills/types.ts";
import type { UserMessage } from "@/types.ts";

export interface ProcessInputDeps {
  input: string;
  cwd: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  agent: AgentConfig;
  skills: readonly Skill[];
  session: Session;
  setSession: (s: Session) => void;
  broker: PromptBroker;
  permissionStore: PermissionStore;
  dispatch: (a: Action) => void;
  abortController: AbortController;
}

export async function processInput(deps: ProcessInputDeps): Promise<void> {
  const { input, session, setSession, dispatch } = deps;

  if (input.startsWith("/") && parseSkillInvocation(input) === null) {
    await handleCommand(deps);
    return;
  }

  let userContent = input;
  const invocation = parseSkillInvocation(input);
  if (invocation) {
    if (invocation.name.length === 0) {
      dispatch({
        type: "system_message",
        text: "Usage: /skill:<name> <your request>. Try /skills.",
        tone: "error",
      });
      return;
    }
    const skill = deps.skills.find((s) => s.name === invocation.name);
    if (!skill) {
      dispatch({
        type: "system_message",
        text: `Unknown skill: ${invocation.name}. Try /skills.`,
        tone: "error",
      });
      return;
    }
    userContent = applySkill(skill, invocation.prompt);
  }

  const userMsg: UserMessage = { role: "user", content: userContent };
  session.messages.push(userMsg);
  appendMessage(deps.cwd, session.id, userMsg);

  dispatch({ type: "turn_started" });
  const beforeCount = session.messages.length;

  try {
    const turnResult = await agentLoop({
      agent: deps.agent,
      provider: deps.provider,
      model: deps.model,
      messages: session.messages,
      systemPrompt: deps.systemPrompt,
      cwd: deps.cwd,
      signal: deps.abortController.signal,
      onEvent: (event) => dispatch({ type: "event", event }),
      prompter: deps.broker.prompter,
      permissionStore: deps.permissionStore,
    });

    for (let i = beforeCount; i < turnResult.messages.length; i++) {
      const m = turnResult.messages[i];
      if (m !== undefined) {
        appendMessage(deps.cwd, session.id, m);
      }
    }
    session.messages = turnResult.messages;

    const cost = calculateCost(deps.model, turnResult.usage);
    dispatch({ type: "turn_finished", usage: turnResult.usage, cost });

    if (!session.header.title && turnResult.stopReason !== "error") {
      const title = await generateSessionTitle(input, deps.provider, deps.model);
      setTitle(deps.cwd, session, title);
      setSession({ ...session });
    }
  } catch (error) {
    dispatch({
      type: "system_message",
      text: `Error: ${(error as Error).message}`,
      tone: "error",
    });
    dispatch({ type: "turn_finished", usage: { inputTokens: 0, outputTokens: 0 }, cost: 0 });
  }
}

async function handleCommand(deps: ProcessInputDeps): Promise<void> {
  const chunks: string[] = [];
  const result = await executeCommand(deps.input, {
    session: deps.session,
    cwd: deps.cwd,
    write: (s: string) => chunks.push(s),
  });
  const text = chunks.join("").trimEnd();
  if (text.length > 0) {
    deps.dispatch({ type: "system_message", text, tone: "info" });
  }
  if (result.type === "exit") {
    process.exit(0);
  }
  if (result.type === "replace_session") {
    deps.setSession(result.session);
  }
}
