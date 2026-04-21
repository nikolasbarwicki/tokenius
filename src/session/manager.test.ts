import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendMessage,
  createSession,
  listSessions,
  loadSession,
  sessionPath,
  setTitle,
} from "./manager.ts";

import type { SessionHeader } from "./types.ts";
import type { Message } from "@/types.ts";

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tokenius-session-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("createSession", () => {
  it("writes a header line and returns an empty in-memory session", () => {
    const { session, path, isFirstInProject } = createSession(cwd, "claude-sonnet-4-6");

    expect(isFirstInProject).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(path).toBe(sessionPath(cwd, session.id));

    expect(session.header.type).toBe("session");
    expect(session.header.model).toBe("claude-sonnet-4-6");
    expect(session.header.cwd).toBe(cwd);
    expect(session.header.title).toBeUndefined();
    expect(session.messages).toEqual([]);
  });

  it("reports isFirstInProject=false once the sessions dir exists", () => {
    createSession(cwd, "m");
    const { isFirstInProject } = createSession(cwd, "m");
    expect(isFirstInProject).toBe(false);
  });

  it("generates distinct ids across rapid creates", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(createSession(cwd, "m").session.id);
    }
    expect(ids.size).toBe(10);
  });
});

describe("appendMessage + loadSession", () => {
  it("roundtrips user, assistant, and tool_result messages in order", () => {
    const { session } = createSession(cwd, "m");
    const msgs: Message[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: "stop",
      },
      { role: "tool_result", toolCallId: "t1", toolName: "read", content: "ok" },
    ];
    for (const m of msgs) {
      appendMessage(cwd, session.id, m);
    }

    const loaded = loadSession(cwd, session.id);
    expect(loaded.id).toBe(session.id);
    expect(loaded.header.model).toBe("m");
    expect(loaded.messages).toEqual(msgs);
  });

  it("throws on missing session file", () => {
    expect(() => loadSession(cwd, "does-not-exist")).toThrow();
  });
});

describe("setTitle", () => {
  it("rewrites the header line without disturbing message entries", () => {
    const { session } = createSession(cwd, "m");
    appendMessage(cwd, session.id, { role: "user", content: "x" });
    appendMessage(cwd, session.id, { role: "user", content: "y" });

    setTitle(cwd, session, "My Title");

    expect(session.header.title).toBe("My Title");
    const loaded = loadSession(cwd, session.id);
    expect(loaded.header.title).toBe("My Title");
    expect(loaded.messages).toHaveLength(2);
    expect(loaded.messages[0]).toEqual({ role: "user", content: "x" });
    expect(loaded.messages[1]).toEqual({ role: "user", content: "y" });
  });

  it("leaves no .tmp file on disk", () => {
    const { session, path } = createSession(cwd, "m");
    setTitle(cwd, session, "x");
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });
});

// Write a session file by hand so tests control header fields (timestamp,
// title) without racing the clock.
function writeSessionFile(root: string, header: SessionHeader, messageCount: number): void {
  const dir = join(root, ".tokenius", "sessions");
  mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify(header)];
  for (let i = 0; i < messageCount; i++) {
    lines.push(JSON.stringify({ type: "message", message: { role: "user", content: `m${i}` } }));
  }
  writeFileSync(join(dir, `${header.id}.jsonl`), `${lines.join("\n")}\n`);
}

describe("listSessions", () => {
  it("returns [] when the sessions dir does not exist", () => {
    expect(listSessions(cwd)).toEqual([]);
  });

  it("sorts summaries by timestamp descending and counts messages", () => {
    writeSessionFile(
      cwd,
      { type: "session", id: "old", timestamp: "2020-01-01T00:00:00.000Z", cwd, model: "m" },
      0,
    );
    writeSessionFile(
      cwd,
      { type: "session", id: "new", timestamp: "2025-06-15T12:00:00.000Z", cwd, model: "m" },
      2,
    );

    const list = listSessions(cwd);
    expect(list.map((s) => s.id)).toEqual(["new", "old"]);
    expect(list[0]?.messageCount).toBe(2);
    expect(list[1]?.messageCount).toBe(0);
    expect(list[0]?.title).toBe("(untitled)");
  });

  it("reflects titles set via setTitle", () => {
    const { session } = createSession(cwd, "m");
    setTitle(cwd, session, "Hello");
    const list = listSessions(cwd);
    expect(list[0]?.title).toBe("Hello");
  });

  it("skips malformed files instead of failing the whole listing", () => {
    writeSessionFile(
      cwd,
      { type: "session", id: "good", timestamp: "2024-01-01T00:00:00.000Z", cwd, model: "m" },
      0,
    );
    // A corrupt file next to a good one shouldn't break /sessions.
    const dir = join(cwd, ".tokenius", "sessions");
    writeFileSync(join(dir, "garbage.jsonl"), "this is not json\n");

    const list = listSessions(cwd);
    expect(list.map((s) => s.id)).toEqual(["good"]);
  });
});
