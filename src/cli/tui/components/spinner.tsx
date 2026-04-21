// Tiny braille spinner. One interval timer driven by the component; stops as
// soon as the component unmounts so idle states don't burn CPU redrawing.

import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import type { Status } from "../store.ts";

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const INTERVAL_MS = 80;

export function Spinner({ status }: { status: Status }): React.ReactElement | null {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (status.kind === "idle") {
      return;
    }
    const t = setInterval(() => {
      setFrame((f) => (f + 1) % FRAMES.length);
    }, INTERVAL_MS);
    return () => clearInterval(t);
  }, [status.kind]);

  if (status.kind === "idle") {
    return null;
  }
  const label = status.kind === "thinking" ? "thinking…" : `running: ${status.tool}`;

  return (
    <Box>
      <Text color="cyan">{FRAMES[frame]}</Text>
      <Text color="gray"> {label}</Text>
    </Box>
  );
}
