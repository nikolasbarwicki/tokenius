// Bridge between the agent loop's PermissionPrompter (promise-based) and the
// TUI's React state (dispatch-based).
//
// Pattern: a broker object holds a listener the App sets when it mounts. The
// prompter function, when called by the loop, notifies the listener and waits
// for the App to call back with the user's responses. This indirection lets
// the prompter be created BEFORE the App mounts (so agent loop wiring can
// keep its synchronous setup) and still dispatch into React state.

import type {
  PermissionPrompter,
  PermissionRequest,
  PermissionResponse,
} from "@/security/permissions.ts";

export interface PromptBroker {
  prompter: PermissionPrompter;
  /** Called by <App /> on mount to receive prompt requests. */
  setListener: (
    listener: (
      requests: readonly PermissionRequest[],
      resolve: (responses: PermissionResponse[]) => void,
    ) => void,
  ) => void;
}

export function createPromptBroker(): PromptBroker {
  type Listener = (
    requests: readonly PermissionRequest[],
    resolve: (responses: PermissionResponse[]) => void,
  ) => void;

  let listener: Listener | null = null;

  const prompter: PermissionPrompter = (requests) =>
    new Promise((resolve) => {
      if (!listener) {
        // Defensive: the App mounts before any user message could trigger a
        // prompt, so this shouldn't fire. Fail closed (deny) rather than
        // leaving the loop hanging forever.
        resolve(requests.map(() => "deny" as PermissionResponse));
        return;
      }
      listener(requests, resolve);
    });

  return {
    prompter,
    setListener: (l) => {
      listener = l;
    },
  };
}
