// Permission flow for destructive operations (currently: bash commands that
// match a CONFIRM_PATTERN). Two moving parts kept separate so the loop can
// test/ship either independently:
//
//   PermissionPrompter — how the user is asked. The default is a readline
//     prompt; Sprint 6 will replace this with proper UI. Tests inject a fake.
//
//   PermissionStore — a per-session Set<reason> of categories the user chose
//     "allow for this session". Keyed on the CONFIRM reason string from
//     command-detection.ts (e.g. "recursive/forced file deletion"). The store
//     is created by the caller (agent loop or CLI) so two concurrent loops
//     don't share approvals.
//
// `resolvePermissions` is the one place that reconciles both: it consults the
// store first, asks the prompter only for unresolved requests, and updates
// the store based on the prompter's answers.
//
// Excluded reasons: some reasons never get "allow for session" — sudo is
// sensitive enough that every invocation should re-prompt. allow_session on an
// excluded reason is downgraded to a one-time allow.

import { createInterface } from "node:readline/promises";

import type { Interface as ReadlineInterface } from "node:readline/promises";

export interface PermissionRequest {
  tool: string;
  /** Human-readable preview of what will happen. For bash: the command itself. */
  description: string;
  /** The CONFIRM reason — also the session-memory key. */
  reason: string;
}

/** Raw user choice. */
export type PermissionResponse = "allow" | "deny" | "allow_session";

/** Post-adjudication outcome the loop acts on. */
export type PermissionDecision = "allow" | "deny";

export type PermissionPrompter = (requests: PermissionRequest[]) => Promise<PermissionResponse[]>;

/**
 * Reasons that never get session-scoped approval. `allow_session` responses
 * for these reasons are treated as a one-time `allow` — the user must confirm
 * again the next time.
 *
 * Criteria for inclusion: irreversible (data/branch gone with no `reflog` path)
 * or affects state outside the local repo (remote branches, shared databases,
 * host-level privileges). Commands that are destructive-but-contained
 * (e.g. "rm -rf ./dist", "git clean") stay session-allowable so tight dev
 * loops aren't repeatedly interrupted.
 *
 * Keys are reason strings from `command-detection.ts`; keep the two files in
 * sync.
 */
export const SESSION_EXCLUDED_REASONS: ReadonlySet<string> = new Set([
  "elevated privileges",
  "force push (destructive)",
  "hard git reset (destructive)",
  "force-delete git branch",
  "SQL DROP TABLE",
  "SQL DROP DATABASE",
]);

/**
 * Session-scoped memory of "allow for session" approvals. Owned by the caller
 * (CLI → agent loop → subagents inherit). Keeping this out of module state
 * means two loops can run side-by-side without cross-contaminating approvals.
 */
export interface PermissionStore {
  has(reason: string): boolean;
  remember(reason: string): void;
  clear(): void;
  snapshot(): ReadonlySet<string>;
}

export function createPermissionStore(): PermissionStore {
  const approvals = new Set<string>();
  return {
    has: (reason) => approvals.has(reason),
    remember: (reason) => approvals.add(reason),
    clear: () => approvals.clear(),
    snapshot: () => new Set(approvals),
  };
}

/**
 * Resolve a batch of permission requests against the store + prompter.
 * Returns one decision per request, in order.
 *
 * The prompter is only called for requests not already approved in the store.
 * `allow_session` answers are remembered (unless the reason is excluded).
 * Length mismatch from the prompter throws — the loop treats that as a
 * programming error, not a user denial.
 */
export async function resolvePermissions(
  requests: readonly PermissionRequest[],
  prompter: PermissionPrompter,
  store: PermissionStore,
): Promise<PermissionDecision[]> {
  if (requests.length === 0) {
    return [];
  }

  const decisions: (PermissionDecision | null)[] = requests.map((req) =>
    store.has(req.reason) ? "allow" : null,
  );

  const pendingIdx: number[] = [];
  const pendingReqs: PermissionRequest[] = [];
  for (const [i, d] of decisions.entries()) {
    if (d === null) {
      pendingIdx.push(i);
      // Safe: i < requests.length because decisions is mapped from requests.
      pendingReqs.push(requests[i] as PermissionRequest);
    }
  }

  if (pendingReqs.length > 0) {
    const responses = await prompter(pendingReqs);
    if (responses.length !== pendingReqs.length) {
      throw new Error(
        `Permission prompter returned ${responses.length} responses for ${pendingReqs.length} requests`,
      );
    }

    for (const [k, response] of responses.entries()) {
      const idx = pendingIdx[k] as number;
      const req = pendingReqs[k] as PermissionRequest;

      switch (response) {
        case "allow":
          decisions[idx] = "allow";
          break;
        case "deny":
          decisions[idx] = "deny";
          break;
        case "allow_session":
          decisions[idx] = "allow";
          if (!SESSION_EXCLUDED_REASONS.has(req.reason)) {
            store.remember(req.reason);
          }
          break;
      }
    }
  }

  return decisions as PermissionDecision[];
}

// --- Default readline-based prompter ---
//
// Minimal, dependency-free. Sprint 6 replaces this with a proper TUI. The
// point of shipping this default is that the smoke test / CLI-free invocation
// can still handle a real confirmation without hanging the process.

export function createReadlinePrompter(): PermissionPrompter {
  return async (requests) => {
    const rl: ReadlineInterface = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const responses: PermissionResponse[] = [];
      for (const req of requests) {
        process.stdout.write(`\n⚠︎ ${req.tool} requires confirmation: ${req.reason}\n`);
        process.stdout.write(`  ${req.description}\n`);
        const answer = await rl.question("  [a]llow once, [s]ession, [d]eny: ");
        const raw = answer.trim().toLowerCase();
        responses.push(parseAnswer(raw));
      }
      return responses;
    } finally {
      rl.close();
    }
  };
}

function parseAnswer(raw: string): PermissionResponse {
  // Deny is the safe default for unrecognized input (including bare enter).
  if (raw === "a" || raw === "allow" || raw === "y" || raw === "yes") {
    return "allow";
  }
  if (raw === "s" || raw === "session") {
    return "allow_session";
  }
  return "deny";
}
