// Partial JSON parser for recovering tool call arguments from truncated streams.
//
// Tool arguments arrive incrementally as `input_json_delta` events. We accumulate
// the raw string and attempt a full parse on `tool_call_end`. When the full parse
// fails (e.g. the stream was interrupted), we attempt recovery by closing open
// structures — unclosed strings, brackets, and braces.

export function parsePartialJson<T = unknown>(incomplete: string): T {
  try {
    return JSON.parse(incomplete) as T;
  } catch {
    return closeBrackets(incomplete) as T;
  }
}

function closeBrackets(input: string): unknown {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of input) {
    if (escaped) {
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      escaped = true;
      continue;
    }

    if (inString) {
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    switch (ch) {
      case '"':
        inString = true;
        break;
      case "{":
      case "[":
        stack.push(ch);
        break;
      case "}":
        if (stack.at(-1) === "{") {
          stack.pop();
        }
        break;
      case "]":
        if (stack.at(-1) === "[") {
          stack.pop();
        }
        break;
    }
  }

  let repaired = input;

  // Close open string
  if (inString) {
    repaired += '"';
  }

  // Strip trailing incomplete key-value pairs:
  //   '{"a": true, "b":'  → '{"a": true}'
  //   '{"a": true, "b"'   → '{"a": true}'
  //   '{"key":'            → '{}'
  repaired = repaired.replace(/,\s*"[^"]*"?\s*:?\s*$/, "");
  repaired = repaired.replace(/,\s*$/, "");
  repaired = repaired.replace(/:\s*$/, "");

  // Close remaining open structures in reverse order
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === "{" ? "}" : "]";
  }

  try {
    return JSON.parse(repaired);
  } catch {
    return {};
  }
}
