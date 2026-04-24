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
        setCursor(Math.max(0, cursorPos - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor(Math.min(value.length, cursorPos + 1));
        return;
      }
      if (key.backspace || key.delete) {
        if (cursorPos === 0) return;
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
