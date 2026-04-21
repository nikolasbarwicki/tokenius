// Post-fence syntax highlighting. We intentionally don't try to tokenize
// mid-stream — incremental highlighting requires a language-aware lexer that
// can resume on partial input, and the visual cost of "plain text until the
// fence closes, then swap to colored" is small (~one render frame).
//
// Input text may contain zero, one, or many fenced blocks. We split on the
// fence markers (```lang ... ```), highlight the content when the block is
// fully closed, and leave any trailing unclosed fence as plain text.

import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";

/**
 * Highlight fenced code blocks in `raw`. Closed fences get colored; unclosed
 * fences (partial during streaming) are passed through as plain text. Opening
 * and closing fence lines themselves are preserved so the output still reads
 * as markdown in the terminal scrollback.
 */
export function highlightMarkdown(raw: string): string {
  // Match ```[lang]\n ... ```  (tolerate end-of-string for unclosed fences)
  // Using lazy `.*?` so adjacent fences don't glue together.
  const fenceRe = /```([A-Za-z0-9_+-]*)?\n([\s\S]*?)(?:```|$)/g;

  let out = "";
  let cursor = 0;
  for (const match of raw.matchAll(fenceRe)) {
    const start = match.index;
    const full = match[0];
    const lang = match[1] ?? "";
    const code = match[2] ?? "";
    const closed = full.endsWith("```");

    // Text before this fence passes through unchanged.
    out += raw.slice(cursor, start);

    if (!closed) {
      // Unclosed fence — during streaming. Render as-is; we'll re-highlight
      // on the next chunk when it closes.
      out += full;
    } else {
      const colored = colorize(code, lang);
      out += `\`\`\`${lang}\n${colored}\`\`\``;
    }

    cursor = start + full.length;
  }
  out += raw.slice(cursor);
  return out;
}

function colorize(code: string, lang: string): string {
  const language = lang && supportsLanguage(lang) ? lang : undefined;
  try {
    return cliHighlight(code, {
      ...(language !== undefined && { language }),
      ignoreIllegals: true,
    });
  } catch {
    // Defensive: cli-highlight can throw on pathological input. Fall back to
    // plain text rather than breaking the whole render.
    return code;
  }
}
