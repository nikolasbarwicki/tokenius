// Per-block renderer. One component, one switch, one source of truth for
// how each Block kind looks on screen. Keeping this in one file means
// visual consistency is cheap — change the tool-call marker once, all of
// transcript plus live stream pick it up.

import { Box, Text } from "ink";

import { highlightMarkdown } from "../lib/highlight.ts";
import { previewArgs } from "../store.ts";

import type { Block } from "../store.ts";

export function BlockView({ block }: { block: Block }): React.ReactElement {
  switch (block.kind) {
    case "user":
      return (
        <Box>
          <Text color="cyan" bold>
            ❯{" "}
          </Text>
          <Text>{block.text}</Text>
        </Box>
      );

    case "text":
      return <Text>{highlightMarkdown(block.text)}</Text>;

    case "thinking":
      return <Text dimColor>{block.text}</Text>;

    case "tool_call": {
      const preview = previewArgs(block.name, block.rawArgs);
      return (
        <Box flexDirection="column">
          <Box>
            <Text color="cyan">→ {block.name}</Text>
            {preview && <Text dimColor> {preview}</Text>}
          </Box>
          {block.result !== undefined && <ResultLine result={block.result} />}
        </Box>
      );
    }

    case "system":
      return <Text color={toneColor(block.tone)}>{block.text}</Text>;

    case "footer": {
      const total = block.usage.inputTokens + block.usage.outputTokens;
      return (
        <Text dimColor>
          {total.toLocaleString()} tokens · ${block.cost.toFixed(4)}
        </Text>
      );
    }
  }
}

function ResultLine({
  result,
}: {
  result: { content: string; isError?: boolean };
}): React.ReactElement {
  if (result.isError) {
    const snippet = result.content.slice(0, 200);
    return (
      <Text color="red">
        {"  "}✖ {snippet}
      </Text>
    );
  }
  const len = result.content.length;
  return (
    <Text color="green">
      {"  "}✓ {len.toLocaleString()} chars
    </Text>
  );
}

function toneColor(tone: "info" | "warn" | "error"): "gray" | "yellow" | "red" {
  switch (tone) {
    case "info":
      return "gray";
    case "warn":
      return "yellow";
    case "error":
      return "red";
  }
}
