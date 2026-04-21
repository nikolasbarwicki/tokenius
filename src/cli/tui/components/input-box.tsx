// Input prompt with per-shell in-memory history. Up/down browses, typing
// anywhere resets the browse cursor to "current line". Enter submits; empty
// submissions are ignored by the parent.
//
// We don't persist history to disk — it's scoped to the running shell,
// matching the readline expectation. Future work: optionally persist across
// runs via ~/.tokenius/history.

import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { useState } from "react";

export interface InputBoxProps {
  disabled: boolean;
  onSubmit: (value: string) => void;
}

export function InputBox(props: InputBoxProps): React.ReactElement {
  const [value, setValue] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  // -1 means "editing current line" (not browsing history).
  const [cursor, setCursor] = useState(-1);
  // Keeps the in-progress text while the user browses upward, so pressing
  // Down past the bottom restores what they were typing.
  const [draft, setDraft] = useState("");

  const handleChange = (next: string): void => {
    setValue(next);
    // Any keystroke that isn't an arrow snaps us back out of browse mode.
    if (cursor !== -1) {
      setCursor(-1);
    }
  };

  const handleSubmit = (submitted: string): void => {
    const trimmed = submitted.trim();
    setValue("");
    setDraft("");
    setCursor(-1);
    if (trimmed.length === 0) {
      return;
    }
    setHistory((h) => (h.at(-1) === trimmed ? h : [...h, trimmed]));
    props.onSubmit(trimmed);
  };

  // Arrow-key navigation lives in this useInput so ink-text-input still owns
  // character editing (word jumps, backspace, etc.).
  useHistoryKeys({
    disabled: props.disabled,
    value,
    history,
    cursor,
    draft,
    setValue,
    setCursor,
    setDraft,
  });

  if (props.disabled) {
    return (
      <Box>
        <Text color="cyan">❯ </Text>
        <Text dimColor>{value || "…"}</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="cyan">❯ </Text>
      <TextInput value={value} onChange={handleChange} onSubmit={handleSubmit} />
    </Box>
  );
}

// --- history navigation ---

interface HistoryKeysConfig {
  disabled: boolean;
  value: string;
  history: readonly string[];
  cursor: number;
  draft: string;
  setValue: (v: string) => void;
  setCursor: (c: number) => void;
  setDraft: (d: string) => void;
}

function useHistoryKeys(cfg: HistoryKeysConfig): void {
  useInput(
    (_input, key) => {
      if (cfg.history.length === 0) {
        return;
      }

      if (key.upArrow) {
        if (cfg.cursor === -1) {
          // Remember the current draft before we walk into history.
          cfg.setDraft(cfg.value);
          const idx = cfg.history.length - 1;
          cfg.setCursor(idx);
          cfg.setValue(cfg.history[idx] ?? "");
        } else if (cfg.cursor > 0) {
          const idx = cfg.cursor - 1;
          cfg.setCursor(idx);
          cfg.setValue(cfg.history[idx] ?? "");
        }
        return;
      }

      if (key.downArrow) {
        if (cfg.cursor === -1) {
          return;
        } // already editing, nothing to do
        const idx = cfg.cursor + 1;
        if (idx >= cfg.history.length) {
          cfg.setCursor(-1);
          cfg.setValue(cfg.draft);
        } else {
          cfg.setCursor(idx);
          cfg.setValue(cfg.history[idx] ?? "");
        }
      }
    },
    { isActive: !cfg.disabled },
  );
}
