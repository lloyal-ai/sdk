import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState } from '../state';
import { formatElapsed } from '../hooks/useElapsed';

export interface FooterProps {
  state: AppState;
}

function gaugeBar(pct: number, width = 12): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function gaugeColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

function activeAgentCount(state: AppState): number {
  let n = 0;
  for (const a of state.agents.values()) {
    if (a.phase !== 'done' && a.phase !== 'idle') n++;
  }
  return n;
}

/** Pipeline-active elapsed: accumulator + (now - resumedAt) while the
 *  timer is running, or just the frozen accumulator when paused. Ticks
 *  on an interval only while running; paused reads are a single value. */
function usePipelineElapsed(state: AppState): number {
  const resumedAt = state.pipelineResumedAt;
  const [, tick] = useState(0);

  useEffect(() => {
    if (resumedAt === null) return;
    const id = setInterval(() => tick((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [resumedAt]);

  if (resumedAt === null) return state.pipelineElapsedMs;
  return state.pipelineElapsedMs + (Date.now() - resumedAt);
}

export function Footer({ state }: FooterProps): React.ReactElement {
  const elapsedMs = usePipelineElapsed(state);
  const pct = state.pressure?.pct ?? 0;
  const agents = activeAgentCount(state);
  const color = gaugeColor(pct);

  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      borderTop
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      paddingTop={0}
    >
      <Box flexDirection="row">
        <Text dimColor>KV </Text>
        <Text color={color}>{gaugeBar(pct)}</Text>
        <Text> {String(pct).padStart(2, ' ')}%</Text>
        <Text dimColor> · </Text>
        <Text>{state.phase}</Text>
        <Text dimColor> · ⏱ </Text>
        <Text>{formatElapsed(elapsedMs)}</Text>
        <Text dimColor> · </Text>
        <Text>{agents} active</Text>
        {state.sourceCount > 0 ? (
          <>
            <Text dimColor> · </Text>
            <Text dimColor>⌕ </Text>
            <Text>{state.sourceCount} sources</Text>
          </>
        ) : null}
      </Box>
    </Box>
  );
}
