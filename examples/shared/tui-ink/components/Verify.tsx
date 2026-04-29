import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

export interface VerifyProps {
  state: AppState;
}
const ms = (t: number): string => `${(t / 1000).toFixed(1)}s`;

export function Verify({ state }: VerifyProps): React.ReactElement | null {
  const { verify } = state;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!verify.active) return;
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, [verify.active]);

  if (!verify.active && !verify.done) return null;

  if (verify.active) {
    return (
      <Box marginBottom={1}>
        <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
        <Text dimColor>Verifying </Text>
        <Text>{verify.count} samples…</Text>
      </Box>
    );
  }

  return (
    <Box marginBottom={1}>
      <Text bold>Verify </Text>
      <Text color="green">✓</Text>
      <Text dimColor>
        {' '}· {verify.count} samples
        {verify.timeMs != null ? ` · ${ms(verify.timeMs)}` : ''}
      </Text>
    </Box>
  );
}
