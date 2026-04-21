// Ctrl+C handler installed at the process level. Deliberately not using Ink's
// useInput: that would race with InputBox and the PermissionModal, both of
// which claim stdin. A process SIGINT handler sits above that and does the
// right thing regardless of what's focused.

import { useCallback, useEffect } from "react";

interface CtrlCDeps {
  busy: boolean;
  abortRef: React.MutableRefObject<AbortController | null>;
  exit: () => void;
}

export function useCtrlC(deps: CtrlCDeps): void {
  const handler = useCallback(() => {
    if (deps.busy) {
      deps.abortRef.current?.abort();
      return;
    }
    deps.exit();
    process.exit(0);
  }, [deps]);

  useEffect(() => {
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  }, [handler]);
}
