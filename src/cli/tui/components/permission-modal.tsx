// Modal rendered when the agent loop awaits a permission decision.
//
// Input model: single-key response (a/s/d/y/n) via Ink's useInput. Arrow keys
// are intentionally not wired — there are only three choices and single-letter
// shortcuts are both faster and more muscle-memorable. The useInput hook is
// opt-in: callers pass an onAnswer handler so tests can render the modal
// without hijacking stdin.

import { Box, Text, useInput } from "ink";

import type { PermissionRequest } from "@/security/permissions.ts";

export interface PermissionModalProps {
  request: PermissionRequest;
  /** Progress label, e.g. "1 of 3". Omitted when only one request. */
  progress?: { current: number; total: number };
  onAnswer: (response: "allow" | "deny" | "allow_session") => void;
}

export function PermissionModal(props: PermissionModalProps): React.ReactElement {
  useInput((input) => {
    const key = input.toLowerCase();
    if (key === "a" || key === "y") {
      props.onAnswer("allow");
    } else if (key === "s") {
      props.onAnswer("allow_session");
    } else if (key === "d" || key === "n") {
      props.onAnswer("deny");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Box>
        <Text color="yellow" bold>
          ⚠ Permission needed
        </Text>
        {props.progress && props.progress.total > 1 && (
          <Text dimColor>
            {" "}
            ({props.progress.current} of {props.progress.total})
          </Text>
        )}
      </Box>
      <Text>
        <Text color="cyan">{props.request.tool}</Text>
        <Text>: </Text>
        <Text>{props.request.reason}</Text>
      </Text>
      <Box marginTop={1}>
        <Text dimColor>{props.request.description}</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          [<Text color="green">a</Text>]llow once · [<Text color="green">s</Text>]ession · [
          <Text color="red">d</Text>]eny
        </Text>
      </Box>
    </Box>
  );
}
