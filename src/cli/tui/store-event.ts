// AgentEvent → state machinery for the TUI store. Kept in its own file so
// store.ts can stay under the line limit; also makes the event-handling
// logic navigable on its own.

import { makeId } from "./store-ids.ts";

import type { Block, StoreState, TextBlock, ThinkingBlock, ToolCallBlock } from "./store-types.ts";
import type { AgentEvent } from "@/agent/types.ts";

export function reduceEvent(state: StoreState, event: AgentEvent): StoreState {
  switch (event.type) {
    case "turn_start":
      return { ...state, status: { kind: "thinking" } };

    case "text_delta":
      return appendToLive(state, "text", event.text);

    case "thinking_delta":
      return appendToLive(state, "thinking", event.thinking);

    case "tool_call_start": {
      const sealed = sealStreamingBlocks(state);
      const tool: ToolCallBlock = {
        kind: "tool_call",
        id: event.id,
        name: event.name,
        rawArgs: "",
      };
      return {
        ...sealed,
        liveBlocks: [...sealed.liveBlocks, tool],
        status: { kind: "running", tool: event.name },
      };
    }

    case "tool_call_args": {
      const liveBlocks = [...state.liveBlocks];
      for (let i = liveBlocks.length - 1; i >= 0; i--) {
        const b = liveBlocks[i];
        if (b && b.kind === "tool_call" && b.result === undefined) {
          liveBlocks[i] = { ...b, rawArgs: event.partialArgs };
          break;
        }
      }
      return { ...state, liveBlocks };
    }

    case "tool_result": {
      const liveBlocks = [...state.liveBlocks];
      let idx = -1;
      for (let i = 0; i < liveBlocks.length; i++) {
        const b = liveBlocks[i];
        if (b && b.kind === "tool_call" && b.result === undefined) {
          idx = i;
          break;
        }
      }
      if (idx === -1) {
        return state;
      }
      const completed: ToolCallBlock = {
        ...(liveBlocks[idx] as ToolCallBlock),
        result: event.result,
      };
      liveBlocks.splice(idx, 1);
      const stillRunning = liveBlocks.some(
        (b): b is ToolCallBlock => b.kind === "tool_call" && b.result === undefined,
      );
      return {
        ...state,
        liveBlocks,
        staticBlocks: [...state.staticBlocks, completed],
        status: stillRunning ? state.status : { kind: "thinking" },
      };
    }

    case "turn_end": {
      const sealed = sealStreamingBlocks(state);
      return {
        ...sealed,
        context: {
          usedTokens: event.usage.inputTokens,
          windowTokens: state.context.windowTokens,
        },
      };
    }

    case "context_limit_reached":
      return pushSystem(
        state,
        "Session context full. Start a new session or /clear to reset.",
        "warn",
      );

    case "turn_limit_reached":
      return pushSystem(state, `Reached turn limit (${event.maxTurns}). Stopping.`, "warn");

    case "subagent_complete":
      return pushSystem(
        state,
        `↳ ${event.agent} done (${event.turns} turns, ${event.tokens.toLocaleString()} tokens, $${event.cost.toFixed(4)})`,
        "info",
      );

    case "error":
      return pushSystem(state, `Error: ${event.error.message}`, "error");
  }
}

function appendToLive(state: StoreState, kind: "text" | "thinking", chunk: string): StoreState {
  const liveBlocks = [...state.liveBlocks];
  const last = liveBlocks.at(-1);
  if (last && last.kind === kind) {
    liveBlocks[liveBlocks.length - 1] = { ...last, text: last.text + chunk };
  } else {
    const fresh: TextBlock | ThinkingBlock =
      kind === "text"
        ? { kind: "text", id: makeId("text"), text: chunk }
        : { kind: "thinking", id: makeId("think"), text: chunk };
    liveBlocks.push(fresh);
  }
  return { ...state, liveBlocks };
}

function sealStreamingBlocks(state: StoreState): StoreState {
  const newlyStatic: Block[] = [];
  const remaining: Block[] = [];
  for (const b of state.liveBlocks) {
    if (b.kind === "text" || b.kind === "thinking") {
      newlyStatic.push(b);
    } else {
      remaining.push(b);
    }
  }
  if (newlyStatic.length === 0) {
    return state;
  }
  return {
    ...state,
    liveBlocks: remaining,
    staticBlocks: [...state.staticBlocks, ...newlyStatic],
  };
}

function pushSystem(state: StoreState, text: string, tone: "info" | "warn" | "error"): StoreState {
  return {
    ...state,
    staticBlocks: [...state.staticBlocks, { kind: "system", id: makeId("sys"), text, tone }],
  };
}
