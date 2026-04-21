// Root App component. Owns the transcript store, drives the agent loop on
// submit (via ./process-input.ts), and coordinates the permission modal,
// input box, and status bar.
//
// Rendering architecture (the interesting bit):
//
//   <Static items={staticBlocks}>      ← Ink commits each item once. Finished
//     <BlockView />                       turns, tool results, and system
//   </Static>                             messages go here; never re-rendered.
//
//   liveBlocks (below Static)          ← The currently streaming block(s).
//                                         Re-rendered on every text_delta.
//                                         Completed blocks migrate to Static.
//
//   <Spinner /> / <PermissionModal />  ← Conditional UI chrome.
//   <StatusBar />                      ← Always-visible footer.
//   <InputBox />                       ← Disabled while the loop is running.
//
// Without <Static>, every text_delta would re-render the whole transcript —
// fine for a one-screen turn, painful for a long conversation. <Static> is
// why Ink can keep up with a streaming LLM.

import { Box, Static, useApp } from "ink";
import { useEffect, useReducer, useRef, useState } from "react";

import { getModelMetadata } from "@/providers/models.ts";

import { BlockView } from "./components/block-view.tsx";
import { InputBox } from "./components/input-box.tsx";
import { PermissionModal } from "./components/permission-modal.tsx";
import { Spinner } from "./components/spinner.tsx";
import { StatusBar } from "./components/status-bar.tsx";
import { processInput } from "./process-input.ts";
import { initialState, reduce } from "./store.ts";
import { useCtrlC } from "./use-ctrl-c.ts";

import type { PromptBroker } from "./prompter.ts";
import type { Block } from "./store.ts";
import type { AgentConfig } from "@/agent/types.ts";
import type { Provider } from "@/providers/types.ts";
import type {
  PermissionRequest,
  PermissionResponse,
  PermissionStore,
} from "@/security/permissions.ts";
import type { Session } from "@/session/types.ts";
import type { Skill } from "@/skills/types.ts";

export interface AppProps {
  cwd: string;
  providerId: string;
  provider: Provider;
  model: string;
  systemPrompt: string;
  session: Session;
  skills: readonly Skill[];
  agent: AgentConfig;
  broker: PromptBroker;
  permissionStore: PermissionStore;
}

export function App(props: AppProps): React.ReactElement {
  const windowTokens = getModelMetadata(props.model).contextWindow;
  const [state, dispatch] = useReducer(reduce, undefined, () => initialState(windowTokens));
  const [session, setSession] = useState<Session>(props.session);
  const { exit } = useApp();

  // Permission bridge: the broker calls us with (requests, resolve). We stash
  // resolve, dispatch a permission_request, and feed the user's answers back
  // via the modal's onAnswer. When we have all responses, resolve the promise.
  const resolveRef = useRef<((r: PermissionResponse[]) => void) | null>(null);
  const responsesRef = useRef<PermissionResponse[]>([]);

  useEffect(() => {
    props.broker.setListener((requests: readonly PermissionRequest[], resolve) => {
      responsesRef.current = [];
      resolveRef.current = resolve;
      dispatch({ type: "permission_request", requests });
    });
  }, [props.broker]);

  const handleAnswer = (response: PermissionResponse): void => {
    responsesRef.current.push(response);
    dispatch({ type: "permission_answer", response });
    if (!state.permission) {
      return;
    }
    if (responsesRef.current.length >= state.permission.requests.length) {
      const resolve = resolveRef.current;
      resolveRef.current = null;
      resolve?.(responsesRef.current);
    }
  };

  const abortRef = useRef<AbortController | null>(null);

  const handleSubmit = (input: string): void => {
    if (state.busy) {
      return;
    }
    dispatch({ type: "user_submit", text: input });
    const abortController = new AbortController();
    abortRef.current = abortController;
    void processInput({
      input,
      cwd: props.cwd,
      provider: props.provider,
      model: props.model,
      systemPrompt: props.systemPrompt,
      agent: props.agent,
      skills: props.skills,
      session,
      setSession,
      broker: props.broker,
      permissionStore: props.permissionStore,
      dispatch,
      abortController,
    }).finally(() => {
      if (abortRef.current === abortController) {
        abortRef.current = null;
      }
    });
  };

  useCtrlC({ busy: state.busy, abortRef, exit });

  return (
    <Box flexDirection="column">
      <Static items={state.staticBlocks}>
        {(block: Block) => (
          <Box key={block.id}>
            <BlockView block={block} />
          </Box>
        )}
      </Static>

      {state.liveBlocks.length > 0 && (
        <Box flexDirection="column">
          {state.liveBlocks.map((block) => (
            <BlockView key={block.id} block={block} />
          ))}
        </Box>
      )}

      {state.permission !== null && state.permission.index < state.permission.requests.length && (
        <Box marginTop={1}>
          <PermissionModal
            request={state.permission.requests[state.permission.index] as PermissionRequest}
            progress={{
              current: state.permission.index + 1,
              total: state.permission.requests.length,
            }}
            onAnswer={handleAnswer}
          />
        </Box>
      )}

      <Box marginTop={1}>
        <Spinner status={state.status} />
      </Box>

      <Box marginTop={1}>
        <StatusBar
          model={props.model}
          sessionId={session.id}
          tokens={{
            inputTokens: state.cumulative.inputTokens,
            outputTokens: state.cumulative.outputTokens,
          }}
          cost={state.cumulative.cost}
          context={state.context}
        />
      </Box>

      <InputBox disabled={state.busy || state.permission !== null} onSubmit={handleSubmit} />
    </Box>
  );
}
