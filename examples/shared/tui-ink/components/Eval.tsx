import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface EvalProps {
  state: AppState;
}

const ms = (t: number): string => `${(t / 1000).toFixed(1)}s`;

export function Eval({ state }: EvalProps): React.ReactElement | null {
  const e = state.evalState;
  if (!e || !e.done) return null;

  const verdict = e.converged === true
    ? <Text color="green">yes</Text>
    : e.converged === false
      ? <Text color="red">no</Text>
      : <Text color="yellow">unknown</Text>;

  return (
    <Box marginBottom={1}>
      <Text bold>Eval </Text>
      <Text>Converged: </Text>
      {verdict}
      <Text dimColor>
        {' '}· {e.sampleCount} samples · {e.tokenCount} tok · {ms(e.timeMs)}
      </Text>
    </Box>
  );
}
