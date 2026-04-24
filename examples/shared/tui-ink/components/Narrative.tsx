import React from 'react';
import { Box } from 'ink';
import type { AppState } from '../state';
import { Column } from './Column';
import { useTerminalSize } from '../hooks/useElapsed';

export interface NarrativeProps {
  state: AppState;
}

/** Rows reserved above + below the narrative row for chrome (header, plan,
 *  synth/verify/eval, footer). Tuned by eye; may need adjusting if the
 *  component tree above or below grows. */
const CHROME_ROWS = 18;
const MIN_COLUMN_WIDTH = 26;
const MIN_BODY_ROWS = 10;

export function Narrative({ state }: NarrativeProps): React.ReactElement | null {
  const [cols, rows] = useTerminalSize();

  const agents = state.researchAgentIds
    .map((id) => state.agents.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a);

  if (agents.length === 0) return null;

  const bodyHeight = Math.max(MIN_BODY_ROWS, rows - CHROME_ROWS);

  // ── Flat: side-by-side columns ────────────────────────────
  if (state.mode === 'flat') {
    const n = agents.length;
    const usable = Math.max(MIN_COLUMN_WIDTH * n, cols - 4);
    const columnWidth = Math.max(MIN_COLUMN_WIDTH, Math.floor(usable / n) - 1);
    const fitsHorizontal = columnWidth * n + n <= cols;

    if (fitsHorizontal) {
      return (
        <Box flexDirection="row" marginBottom={1}>
          {agents.map((agent) => (
            <Column
              key={agent.id}
              agent={agent}
              headerPrefix={null}
              bodyHeight={bodyHeight}
              width={columnWidth}
            />
          ))}
        </Box>
      );
    }

    // Fall back to vertical stacking when terminal is too narrow.
    return (
      <Box flexDirection="column" marginBottom={1}>
        {agents.map((agent) => (
          <Column
            key={agent.id}
            agent={agent}
            headerPrefix={null}
            bodyHeight={Math.max(MIN_BODY_ROWS, Math.floor(bodyHeight / n))}
          />
        ))}
      </Box>
    );
  }

  // ── Chain: stacked columns, full width ─────────────────────
  const perTask = Math.max(MIN_BODY_ROWS, Math.floor(bodyHeight / Math.max(1, agents.length)));
  return (
    <Box flexDirection="column" marginBottom={1}>
      {agents.map((agent) => (
        <Column
          key={agent.id}
          agent={agent}
          headerPrefix={`Task ${(agent.taskIndex ?? 0) + 1}`}
          bodyHeight={perTask}
        />
      ))}
    </Box>
  );
}
