// High-signal secret patterns. Goal: catch the LLM writing a real API key
// into a file the user would then commit. Not a general-purpose scanner —
// false positives here mean the LLM retries with a different approach, which
// is still better than a leaked credential.

const SECRET_PATTERNS: { pattern: RegExp; label: string }[] = [
  { pattern: /\bsk-ant-[a-zA-Z0-9_-]{20,}/, label: "Anthropic API key" },
  { pattern: /\bsk-proj-[a-zA-Z0-9_-]{20,}/, label: "OpenAI project key" },
  { pattern: /\bsk-[a-zA-Z0-9]{20,}/, label: "OpenAI API key" },
  { pattern: /\bghp_[a-zA-Z0-9]{36,}/, label: "GitHub personal token" },
  { pattern: /\bgho_[a-zA-Z0-9]{36,}/, label: "GitHub OAuth token" },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/, label: "AWS access key" },
];

// Generic key/value heuristic: a variable named like a secret, followed by an
// assignment, followed by a long opaque value. Guard against matching short
// placeholders or obvious docs ("YOUR_API_KEY_HERE").
const GENERIC_KV =
  /(?:api[_-]?key|secret|token|passwd|password|auth[_-]?token)\s*[:=]\s*["']?([a-zA-Z0-9_+\-/]{24,})["']?/i;
const PLACEHOLDER_VALUES = /^(your[_-]?|xxx|placeholder|example|todo|change[_-]?me)/i;

export interface SecretsCheck {
  found: boolean;
  labels: string[];
}

export function containsSecrets(content: string): SecretsCheck {
  const labels: string[] = [];

  for (const { pattern, label } of SECRET_PATTERNS) {
    if (pattern.test(content)) {
      labels.push(label);
    }
  }

  const kv = content.match(GENERIC_KV);
  if (kv?.[1] && !PLACEHOLDER_VALUES.test(kv[1])) {
    labels.push("potential credential assignment");
  }

  return { found: labels.length > 0, labels };
}
