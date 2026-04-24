/**
 * Minimal single-line text input for Ink. No third-party dep.
 *
 * Supports: character entry, backspace/delete, left/right/home/end arrows,
 * optional masking (for API keys). Focused prop controls whether useInput
 * is active so multiple inputs can coexist in the tree.
 *
 * Deliberately does not handle multi-line, selection, or clipboard.
 */

import React, { useState } from 'react';
import { Text, useInput } from 'ink';

export interface TextInputProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: (value: string) => void;
  onCancel?: () => void;
  placeholder?: string;
  focused?: boolean;
  /** Render * in place of every character. Typed character is still stored
   *  in `value`; only the display is masked. */
  mask?: boolean;
  color?: string;
}

export function TextInput({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder = '',
  focused = true,
  mask = false,
  color,
}: TextInputProps): React.ReactElement {
  const [cursor, setCursor] = useState(value.length);

  // Keep cursor sane if value changes externally (e.g. prefill).
  const cursorPos = Math.min(cursor, value.length);

  useInput(
    (input, key) => {
      if (key.return) {
        onSubmit?.(value);
        return;
      }
      if (key.escape) {
        onCancel?.();
        return;
      }
      if (key.leftArrow) {
        if (key.meta || key.ctrl) {
          // Opt+← (Mac) / Ctrl+← (Windows) — jump word back.
          setCursor(prevWordStart(value, cursorPos));
        } else {
          setCursor(Math.max(0, cursorPos - 1));
        }
        return;
      }
      if (key.rightArrow) {
        if (key.meta || key.ctrl) {
          // Opt+→ (Mac) / Ctrl+→ (Windows) — jump word forward.
          setCursor(nextWordEnd(value, cursorPos));
        } else {
          setCursor(Math.min(value.length, cursorPos + 1));
        }
        return;
      }
      // Home / End — real keys on Windows, Fn+←/→ on Mac laptops. Ink 4
      // doesn't expose these in its Key type; we detect the raw escape
      // sequences that reach the process.
      if (input === '\x1b[H' || input === '\x1bOH') {
        setCursor(0);
        return;
      }
      if (input === '\x1b[F' || input === '\x1bOF') {
        setCursor(value.length);
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorPos === 0) return;
        if (key.meta || key.ctrl) {
          // Opt+Backspace (Mac, Meta+Backspace over the wire) and
          // Ctrl+Backspace (Windows) — delete the whole word to the left.
          const cutPoint = prevWordStart(value, cursorPos);
          onChange(value.slice(0, cutPoint) + value.slice(cursorPos));
          setCursor(cutPoint);
          return;
        }
        const next = value.slice(0, cursorPos - 1) + value.slice(cursorPos);
        setCursor(cursorPos - 1);
        onChange(next);
        return;
      }
      if (key.ctrl && input === 'a') {
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'e') {
        setCursor(value.length);
        return;
      }
      if (key.ctrl && input === 'u') {
        // Kill-to-start-of-line (readline). Most terminals map
        // Cmd+Backspace (macOS) to Ctrl+U — so this is also the "clear
        // input" shortcut the user likely expects.
        onChange(value.slice(cursorPos));
        setCursor(0);
        return;
      }
      if (key.ctrl && input === 'k') {
        // Kill-to-end-of-line.
        onChange(value.slice(0, cursorPos));
        return;
      }
      if (key.ctrl && input === 'w') {
        // Delete word backwards — matches iTerm's Option+Backspace.
        const before = value.slice(0, cursorPos);
        const match = /\S+\s*$/.exec(before);
        const cutPoint = match ? match.index : 0;
        onChange(value.slice(0, cutPoint) + value.slice(cursorPos));
        setCursor(cutPoint);
        return;
      }
      if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow) {
        return;
      }
      // Normal character(s). input may be multi-char for pastes.
      if (input.length > 0) {
        const next = value.slice(0, cursorPos) + input + value.slice(cursorPos);
        setCursor(cursorPos + input.length);
        onChange(next);
      }
    },
    { isActive: focused },
  );

  const display = mask ? '*'.repeat(value.length) : value;
  const isEmpty = value.length === 0;

  if (isEmpty) {
    return (
      <Text>
        <Text color={color}>{focused ? '▎' : ''}</Text>
        <Text dimColor>{placeholder}</Text>
      </Text>
    );
  }

  if (!focused) {
    return <Text color={color}>{display}</Text>;
  }

  const before = display.slice(0, cursorPos);
  const at = display.slice(cursorPos, cursorPos + 1);
  const after = display.slice(cursorPos + 1);
  return (
    <Text color={color}>
      {before}
      <Text inverse>{at || ' '}</Text>
      {after}
    </Text>
  );
}

// ── Word-boundary helpers ────────────────────────────────────────

/** Position of the start of the word before `pos`, skipping any trailing
 *  whitespace. Matches readline's `backward-word` semantics. */
function prevWordStart(value: string, pos: number): number {
  if (pos <= 0) return 0;
  let i = pos;
  while (i > 0 && /\s/.test(value[i - 1])) i--;
  while (i > 0 && !/\s/.test(value[i - 1])) i--;
  return i;
}

/** Position of the end of the word at or after `pos`, skipping any leading
 *  whitespace. Matches readline's `forward-word`. */
function nextWordEnd(value: string, pos: number): number {
  const len = value.length;
  if (pos >= len) return len;
  let i = pos;
  while (i < len && /\s/.test(value[i])) i++;
  while (i < len && !/\s/.test(value[i])) i++;
  return i;
}
