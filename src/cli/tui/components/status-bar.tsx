// Bottom-of-screen status line: model · session id · cumulative tokens + cost
// · context-window percentage. The model/session never change; the rest
// updates per turn. Kept to one line so it doesn't push the input off-screen
// on small terminals.

import { Box, Text } from "ink";

import { formatContextIndicator } from "../lib/context-indicator.ts";

export interface StatusBarProps {
  model: string;
  sessionId: string;
  tokens: { inputTokens: number; outputTokens: number };
  cost: number;
  context: { usedTokens: number; windowTokens: number };
}

export function StatusBar(props: StatusBarProps): React.ReactElement {
  const total = props.tokens.inputTokens + props.tokens.outputTokens;
  const ctx = formatContextIndicator(props.context.usedTokens, props.context.windowTokens);

  return (
    <Box flexDirection="row" columnGap={1}>
      <Text color="cyan">{props.model}</Text>
      <Text dimColor>·</Text>
      <Text dimColor>{props.sessionId}</Text>
      <Text dimColor>·</Text>
      <Text dimColor>
        {total.toLocaleString()} tokens · ${props.cost.toFixed(4)}
      </Text>
      <Text dimColor>·</Text>
      <Text color={ctx.color}>{ctx.label}</Text>
    </Box>
  );
}
