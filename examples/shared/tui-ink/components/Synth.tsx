import React from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';

export interface SynthProps {
  state: AppState;
}

const ms = (t: number): string => `${(t / 1000).toFixed(1)}s`;

export function Synth({ state }: SynthProps): React.ReactElement | null {
  const { synth } = state;
  if (!synth.open && !synth.done) return null;

  const header = synth.done ? (
    <Box>
      <Text bold>Synthesis </Text>
      <Text color="green">✓</Text>
      {synth.stats ? (
        <Text dimColor>
          {' '}· {synth.stats.tokens} tok · {synth.stats.toolCalls} tools ·{' '}
          {Number.isFinite(synth.stats.ppl) ? `ppl ${synth.stats.ppl.toFixed(2)} · ` : ''}
          {ms(synth.stats.timeMs)}
        </Text>
      ) : null}
    </Box>
  ) : (
    <Box>
      <Text bold>Synthesis</Text>
      <Text color="cyan"> ●</Text>
    </Box>
  );

  const body = synth.buffer.trim();

  return (
    <Box flexDirection="column" marginBottom={1}>
      {header}
      {body ? (
        <Box paddingLeft={2} marginTop={0}>
          <Text>
            {body}
            {synth.open ? '▎' : ''}
          </Text>
        </Box>
      ) : synth.open ? (
        <Box paddingLeft={2}>
          <Text dimColor>▎</Text>
        </Box>
      ) : null}
    </Box>
  );
}
