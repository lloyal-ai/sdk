/**
 * Spinner shown while the planner is producing the plan. Keeps the
 * transition from composer → plan_review visibly active.
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

export const PlanningSpinner = memo(function PlanningSpinner({
  state,
}: {
  state: AppState;
}): React.ReactElement {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setFrame((f) => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_TICK_MS,
    );
    return () => clearInterval(id);
  }, []);
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text bold>{state.query}</Text>
      <Box marginTop={1}>
        <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
        <Text dimColor>Planning…</Text>
      </Box>
    </Box>
  );
});
