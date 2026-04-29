import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface AnswerProps {
  state: AppState;
}

/**
 * The synth buffer already rendered the answer while streaming. We skip
 * re-rendering it here if synth completed successfully with non-empty
 * buffer — that's the same policy the ANSI TUI used (answerHandler
 * short-circuits when synth streamed).
 */
export function Answer({ state }: AnswerProps): React.ReactElement | null {
  if (!state.answer) return null;
  if (state.synth.done && state.synth.buffer.trim().length > 0) return null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text dimColor>───────────────────────────────────────</Text>
      <Box marginTop={1} paddingLeft={2}>
        <Text>{state.answer.trim()}</Text>
      </Box>
    </Box>
  );
}
