// Session manager — append-only JSONL persistence.
//
// One session = one `.tokenius/sessions/{id}.jsonl` file in the project cwd:
//   line 1:   SessionHeader (metadata, written at createSession)
//   line 2+:  MessageEntry  (one per appended Message)
//
// Header-first layout lets listSessions() build summaries by reading each
// file's first line. Line-based append means a crash loses at most the
// in-flight write; the conversation up to that point is already durable.
//
// We deliberately do NOT support compaction. When context fills up the CLI
// stops the session; users start a new one. That simplifies the file format
// (no cut points, no summaries) and makes replay trivial.
//
// All I/O is synchronous. The files are small, the LLM call dominates, and
// sync keeps error handling and callsite ergonomics simple.
//
// setTitle is the one place we rewrite an existing file. It's atomic:
// write-tmp + rename. Same filesystem, so the rename is all-or-nothing.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import type {
  MessageEntry,
  Session,
  SessionEntry,
  SessionHeader,
  SessionSummary,
} from "./types.ts";
import type { Message } from "@/types.ts";

function sessionsDir(cwd: string): string {
  return join(cwd, ".tokenius", "sessions");
}

export function sessionPath(cwd: string, id: string): string {
  return join(sessionsDir(cwd), `${id}.jsonl`);
}

export interface CreateSessionResult {
  session: Session;
  path: string;
  /** True when `.tokenius/sessions/` did not exist before this call. */
  isFirstInProject: boolean;
}

export function createSession(cwd: string, model: string): CreateSessionResult {
  const dir = sessionsDir(cwd);
  const isFirstInProject = !existsSync(dir);
  mkdirSync(dir, { recursive: true });

  const id = Bun.randomUUIDv7();
  const header: SessionHeader = {
    type: "session",
    id,
    timestamp: new Date().toISOString(),
    cwd,
    model,
  };
  const path = sessionPath(cwd, id);
  appendFileSync(path, `${JSON.stringify(header)}\n`);

  return {
    session: { id, header, messages: [] },
    path,
    isFirstInProject,
  };
}

export function appendMessage(cwd: string, sessionId: string, message: Message): void {
  const entry: MessageEntry = { type: "message", message };
  appendFileSync(sessionPath(cwd, sessionId), `${JSON.stringify(entry)}\n`);
}

/**
 * Rewrite the header line with a new title. Atomic via write-tmp + rename so
 * a crash mid-write can never leave a truncated session file. Mutates
 * `session.header` so the in-memory copy stays in sync with disk.
 */
export function setTitle(cwd: string, session: Session, title: string): void {
  const path = sessionPath(cwd, session.id);
  const text = readFileSync(path, "utf8");
  const nl = text.indexOf("\n");
  if (nl === -1) {
    throw new Error(`Session file malformed (no newline): ${path}`);
  }

  const updated: SessionHeader = { ...session.header, title };
  const rest = text.slice(nl); // keeps leading \n
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(updated)}${rest}`);
  renameSync(tmpPath, path);
  session.header = updated;
}

export function loadSession(cwd: string, id: string): Session {
  const path = sessionPath(cwd, id);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n").filter(Boolean);
  if (lines.length === 0) {
    throw new Error(`Empty session file: ${path}`);
  }

  const entries = lines.map((l) => JSON.parse(l) as SessionEntry);
  const first = entries[0];
  if (!first || first.type !== "session") {
    throw new Error(`Session file missing header: ${path}`);
  }

  const messages: Message[] = [];
  for (const entry of entries.slice(1)) {
    if (entry.type === "message") {
      messages.push(entry.message);
    }
  }
  return { id: first.id, header: first, messages };
}

export function listSessions(cwd: string): SessionSummary[] {
  const dir = sessionsDir(cwd);
  if (!existsSync(dir)) {
    return [];
  }

  const summaries: SessionSummary[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) {
      continue;
    }
    // A half-written or hand-edited file shouldn't nuke the whole listing.
    // Skip and keep going.
    try {
      const text = readFileSync(join(dir, f), "utf8");
      const lines = text.split("\n").filter(Boolean);
      const first = lines[0];
      if (!first) {
        continue;
      }
      const header = JSON.parse(first) as SessionHeader;
      summaries.push({
        id: header.id,
        title: header.title ?? "(untitled)",
        cwd: header.cwd,
        timestamp: header.timestamp,
        messageCount: lines.length - 1,
      });
    } catch {
      continue;
    }
  }

  return summaries.toSorted((a, b) => b.timestamp.localeCompare(a.timestamp));
}
