// Session persistence types.
//
// A session is a single conversation persisted as a JSONL file:
//   line 1: SessionHeader (metadata about the run)
//   line 2+: MessageEntry (one per Message appended over time)
//
// The header-first layout lets listSessions() read just the first line of
// each file to build a summary, without parsing the whole conversation.

import type { Message } from "@/types.ts";

// --- On-disk entry shapes ---

export interface SessionHeader {
  type: "session";
  id: string;
  /** ISO-8601, session creation time. */
  timestamp: string;
  /** Working directory the session was created in. Metadata, not a filter. */
  cwd: string;
  /** Model id at session creation. Not updated if /model switches mid-session. */
  model: string;
  /** Auto-generated after the first turn; absent until then. */
  title?: string;
}

export interface MessageEntry {
  type: "message";
  message: Message;
}

export type SessionEntry = SessionHeader | MessageEntry;

// --- In-memory session ---

export interface Session {
  id: string;
  header: SessionHeader;
  messages: Message[];
}

// --- Listing ---

export interface SessionSummary {
  id: string;
  title: string;
  cwd: string;
  timestamp: string;
  messageCount: number;
}
