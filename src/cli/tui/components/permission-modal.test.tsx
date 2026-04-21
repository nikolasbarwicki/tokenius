import { describe, expect, it } from "bun:test";

import { render } from "ink-testing-library";
import React from "react";

import { PermissionModal } from "./permission-modal.tsx";

function stripAnsi(s: string): string {
  // oxlint-disable-next-line no-control-regex
  return s.replaceAll(/\[[0-9;]*m/g, "");
}

describe("PermissionModal", () => {
  it("renders tool name, reason, description, and choices", () => {
    const { lastFrame } = render(
      React.createElement(PermissionModal, {
        request: {
          tool: "bash",
          description: "rm -rf ./dist",
          reason: "recursive/forced file deletion",
        },
        onAnswer: () => {},
      }),
    );
    const frame = stripAnsi(lastFrame() ?? "");
    expect(frame).toContain("Permission needed");
    expect(frame).toContain("bash");
    expect(frame).toContain("recursive/forced file deletion");
    expect(frame).toContain("rm -rf ./dist");
    expect(frame).toContain("[a]llow");
    expect(frame).toContain("[s]ession");
    expect(frame).toContain("[d]eny");
  });

  it("shows progress when more than one request is pending", () => {
    const { lastFrame } = render(
      React.createElement(PermissionModal, {
        request: { tool: "bash", description: "git reset --hard", reason: "hard git reset" },
        progress: { current: 2, total: 3 },
        onAnswer: () => {},
      }),
    );
    expect(stripAnsi(lastFrame() ?? "")).toContain("(2 of 3)");
  });

  it("hides progress when a single request is pending", () => {
    const { lastFrame } = render(
      React.createElement(PermissionModal, {
        request: { tool: "bash", description: "x", reason: "y" },
        progress: { current: 1, total: 1 },
        onAnswer: () => {},
      }),
    );
    expect(stripAnsi(lastFrame() ?? "")).not.toContain("of 1");
  });

  it("invokes onAnswer('allow') on 'a'", () => {
    const answers: string[] = [];
    const { stdin } = render(
      React.createElement(PermissionModal, {
        request: { tool: "bash", description: "x", reason: "y" },
        onAnswer: (r) => answers.push(r),
      }),
    );
    stdin.write("a");
    expect(answers).toEqual(["allow"]);
  });

  it("invokes onAnswer('allow_session') on 's'", () => {
    const answers: string[] = [];
    const { stdin } = render(
      React.createElement(PermissionModal, {
        request: { tool: "bash", description: "x", reason: "y" },
        onAnswer: (r) => answers.push(r),
      }),
    );
    stdin.write("s");
    expect(answers).toEqual(["allow_session"]);
  });

  it("invokes onAnswer('deny') on 'd' or 'n'", () => {
    const answers: string[] = [];
    const { stdin } = render(
      React.createElement(PermissionModal, {
        request: { tool: "bash", description: "x", reason: "y" },
        onAnswer: (r) => answers.push(r),
      }),
    );
    stdin.write("d");
    expect(answers).toEqual(["deny"]);
  });
});
