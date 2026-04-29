/**
 * Persistent clarify panel — shown above the composer while the user
 * types their answer. Keeps the planner's questions visible so the user
 * doesn't have to remember them.
 */

import React, { memo } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface ClarifyPanelProps {
  state: AppState;
}

export const ClarifyPanel = memo(function ClarifyPanel({
  state,
}: ClarifyPanelProps): React.ReactElement | null {
  if (!state.clarifyContext) return null;
  const { originalQuery, questions } = state.clarifyContext;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{originalQuery}</Text>
      <Text dimColor>A few questions to narrow this down.</Text>
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="yellow"
        paddingX={1}
        marginTop={1}
      >
        {questions.map((q, i) => (
          <Text key={i}>
            <Text dimColor>({i + 1})</Text> {q}
          </Text>
        ))}
      </Box>
    </Box>
  );
});
