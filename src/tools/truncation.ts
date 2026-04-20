// Mandatory output truncation — every tool result passes through here before
// reaching the LLM. Two directions:
//
//   truncateHead — keep the beginning (file reads, search results)
//   truncateTail — keep the end (bash output: errors are at the bottom)
//
// Both enforce MAX_LINES and MAX_BYTES and snap to line boundaries so the LLM
// never sees a dangling half-line.

export const MAX_LINES = 2000;
export const MAX_BYTES = 50_000;

export interface TruncationResult {
  content: string;
  wasTruncated: boolean;
  originalLines: number;
  originalBytes: number;
}

function countLines(input: string): number {
  if (input.length === 0) {
    return 0;
  }
  let n = 1;
  for (const ch of input) {
    if (ch === "\n") {
      n++;
    }
  }
  // A trailing newline shouldn't count an empty final line
  return input.endsWith("\n") ? n - 1 : n;
}

function formatNotice(
  position: "head" | "tail",
  keptLines: number,
  originalLines: number,
  keptBytes: number,
  originalBytes: number,
): string {
  const which = position === "head" ? "first" : "last";
  return `[Output truncated: showing ${which} ${keptLines} of ${originalLines} lines (${keptBytes}B of ${originalBytes}B). Use offset/limit or grep to narrow the search.]`;
}

export function truncateHead(input: string): TruncationResult {
  const originalBytes = Buffer.byteLength(input, "utf8");
  const originalLines = countLines(input);

  if (originalLines <= MAX_LINES && originalBytes <= MAX_BYTES) {
    return { content: input, wasTruncated: false, originalLines, originalBytes };
  }

  // Byte-limited slice: cut at or before MAX_BYTES, then back off to the last newline.
  // Line-limited slice: take first MAX_LINES.
  const lines = input.split("\n");
  const lineCapped = lines.slice(0, MAX_LINES).join("\n");

  let kept = lineCapped;
  if (Buffer.byteLength(kept, "utf8") > MAX_BYTES) {
    // Walk back to the last newline before MAX_BYTES.
    const buf = Buffer.from(kept, "utf8");
    const slice = buf.subarray(0, MAX_BYTES).toString("utf8");
    const lastNewline = slice.lastIndexOf("\n");
    kept = lastNewline === -1 ? "" : slice.slice(0, lastNewline);
  }

  const keptLines = countLines(kept);
  const keptBytes = Buffer.byteLength(kept, "utf8");

  return {
    content: `${kept}\n\n${formatNotice("head", keptLines, originalLines, keptBytes, originalBytes)}`,
    wasTruncated: true,
    originalLines,
    originalBytes,
  };
}

export function truncateTail(input: string): TruncationResult {
  const originalBytes = Buffer.byteLength(input, "utf8");
  const originalLines = countLines(input);

  if (originalLines <= MAX_LINES && originalBytes <= MAX_BYTES) {
    return { content: input, wasTruncated: false, originalLines, originalBytes };
  }

  const lines = input.split("\n");
  const lineCapped =
    lines.length > MAX_LINES ? lines.slice(lines.length - MAX_LINES).join("\n") : lines.join("\n");

  let kept = lineCapped;
  if (Buffer.byteLength(kept, "utf8") > MAX_BYTES) {
    // Walk forward from the end to the first newline after (byteLength - MAX_BYTES).
    const buf = Buffer.from(kept, "utf8");
    const slice = buf.subarray(buf.length - MAX_BYTES).toString("utf8");
    const firstNewline = slice.indexOf("\n");
    kept = firstNewline === -1 ? "" : slice.slice(firstNewline + 1);
  }

  const keptLines = countLines(kept);
  const keptBytes = Buffer.byteLength(kept, "utf8");

  return {
    content: `${formatNotice("tail", keptLines, originalLines, keptBytes, originalBytes)}\n\n${kept}`,
    wasTruncated: true,
    originalLines,
    originalBytes,
  };
}
