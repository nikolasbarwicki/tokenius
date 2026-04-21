// Top-level store: initialState + reduce (action → state). The heavy lifting
// for AgentEvents lives in store-event.ts so this file stays focused on the
// app-level actions (user_submit, turn_started, permission_*).
//
// Two-bucket transcript design (lives in StoreState):
//
//   staticBlocks — append-only. Goes into <Static>, so Ink commits each block
//                  once and never redraws it. Critical for perf on long turns.
//   liveBlocks   — the currently-in-flight block(s). Re-rendered on every
//                  delta. When a live block finalizes (turn_end closes text,
//                  tool_result closes a tool_call) it moves to staticBlocks.

import { reduceEvent } from "./store-event.ts";
import { makeId } from "./store-ids.ts";

import type { Action, StoreState } from "./store-types.ts";

export { previewArgs } from "./lib/preview.ts";
export type {
  Action,
  Block,
  FooterBlock,
  PermissionModalState,
  Status,
  StoreState,
  SystemBlock,
  TextBlock,
  ThinkingBlock,
  ToolCallBlock,
  UserBlock,
} from "./store-types.ts";

export function initialState(windowTokens: number): StoreState {
  return {
    staticBlocks: [],
    liveBlocks: [],
    status: { kind: "idle" },
    permission: null,
    context: { usedTokens: 0, windowTokens },
    cumulative: { inputTokens: 0, outputTokens: 0, cost: 0 },
    busy: false,
  };
}

export function reduce(state: StoreState, action: Action): StoreState {
  switch (action.type) {
    case "user_submit":
      return {
        ...state,
        staticBlocks: [
          ...state.staticBlocks,
          { kind: "user", id: makeId("user"), text: action.text },
        ],
      };

    case "system_message":
      return {
        ...state,
        staticBlocks: [
          ...state.staticBlocks,
          {
            kind: "system",
            id: makeId("sys"),
            text: action.text,
            tone: action.tone ?? "info",
          },
        ],
      };

    case "turn_started":
      return { ...state, busy: true, status: { kind: "thinking" } };

    case "turn_finished":
      return {
        ...state,
        busy: false,
        status: { kind: "idle" },
        cumulative: {
          inputTokens: state.cumulative.inputTokens + action.usage.inputTokens,
          outputTokens: state.cumulative.outputTokens + action.usage.outputTokens,
          cost: state.cumulative.cost + action.cost,
        },
        staticBlocks: [
          ...state.staticBlocks,
          { kind: "footer", id: makeId("foot"), usage: action.usage, cost: action.cost },
        ],
      };

    case "event":
      return reduceEvent(state, action.event);

    case "permission_request":
      return {
        ...state,
        permission: { requests: action.requests, index: 0, responses: [] },
      };

    case "permission_answer": {
      if (!state.permission) {
        return state;
      }
      const responses = [...state.permission.responses, action.response];
      if (responses.length >= state.permission.requests.length) {
        return { ...state, permission: null };
      }
      return {
        ...state,
        permission: { ...state.permission, index: state.permission.index + 1, responses },
      };
    }

    case "permission_cancel":
      return { ...state, permission: null };
  }
}
