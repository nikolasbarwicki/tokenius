// Two-tier gating for bash commands:
//   - BLOCKED: never run. Returns { allowed: false }.
//   - CONFIRM: legitimate but destructive. Returns { requiresConfirmation: true }.
// The caller (bash tool) decides what to do with a confirmation — in Sprint 2
// it defers to ToolContext.confirm, which defaults to allow.

export interface CommandCheck {
  allowed: boolean;
  requiresConfirmation: boolean;
  reason?: string;
}

const BLOCKED_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*\s+)*\/(?!\w)/, reason: "rm targeting the filesystem root" },
  { pattern: /\bmkfs\b/, reason: "filesystem format" },
  { pattern: /\bdd\s+[^|&;]*of=\/dev\//, reason: "dd writing to a device" },
  { pattern: />\s*\/dev\/[sh]d/, reason: "redirect to block device" },
  { pattern: /\bcurl\b[^|&;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: "curl piped to shell" },
  { pattern: /\bwget\b[^|&;]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: "wget piped to shell" },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, reason: "fork bomb" },
];

const CONFIRM_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(?:-[a-zA-Z]*[rf][a-zA-Z]*\s+)/, reason: "recursive/forced file deletion" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "hard git reset (destructive)" },
  { pattern: /\bgit\s+push\s+[^&|;]*--force\b/, reason: "force push (destructive)" },
  { pattern: /\bgit\s+push\s+[^&|;]*-f\b/, reason: "force push (destructive)" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, reason: "git clean removes untracked files" },
  { pattern: /\bgit\s+branch\s+-D\b/, reason: "force-delete git branch" },
  { pattern: /\bdrop\s+table\b/i, reason: "SQL DROP TABLE" },
  { pattern: /\bdrop\s+database\b/i, reason: "SQL DROP DATABASE" },
  { pattern: /\bchmod\s+(?:-[a-zA-Z]+\s+)*777\b/, reason: "world-writable permissions" },
  { pattern: /\bsudo\b/, reason: "elevated privileges" },
];

export function checkCommand(command: string): CommandCheck {
  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: false, requiresConfirmation: false, reason };
    }
  }

  for (const { pattern, reason } of CONFIRM_PATTERNS) {
    if (pattern.test(command)) {
      return { allowed: true, requiresConfirmation: true, reason };
    }
  }

  return { allowed: true, requiresConfirmation: false };
}
