// Color-coded context-window indicator shared by the StatusBar and any other
// surface that wants to show "how full is the window." Returns both the label
// and the Ink color name so callers stay render-agnostic — React components
// map `color` onto `<Text color={...}>`, tests assert on the label.

export type ContextColor = "green" | "yellow" | "red";

export interface ContextIndicator {
  label: string;
  color: ContextColor;
}

export function formatContextIndicator(usedTokens: number, windowTokens: number): ContextIndicator {
  const pct = windowTokens > 0 ? (usedTokens / windowTokens) * 100 : 0;
  const used = Math.round(usedTokens / 1000);
  const total = Math.round(windowTokens / 1000);
  const label = `[${used}k / ${total}k tokens · ${Math.round(pct)}%]`;
  return { label, color: pickColor(pct) };
}

function pickColor(pct: number): ContextColor {
  if (pct < 50) {
    return "green";
  }
  if (pct < 80) {
    return "yellow";
  }
  return "red";
}
