/**
 * React wrapper around `routeEdges`. The pure routing logic lives in
 * `./edge-router.ts` so smoke tests can exercise it without importing
 * Ink (which pulls in yoga-wasm-web's top-level await).
 */

import React from 'react';
import { Box, Text } from 'ink';
import { routeEdges, type EdgeEndpoint } from './edge-router';

export type { EdgeEndpoint } from './edge-router';

export interface EdgeRowProps {
  parents: EdgeEndpoint[];
  children: EdgeEndpoint[];
  edges: [string, string][];
  width: number;
}

export const EdgeRow: React.FC<EdgeRowProps> = ({ parents, children, edges, width }) => {
  const { rows } = routeEdges(parents, children, edges, width);
  return (
    <Box flexDirection="column" flexShrink={0}>
      {rows.map((row, i) => <PaddedRow key={i} row={row} width={width} />)}
    </Box>
  );
};

/** Ink's flex layout collapses ASCII spaces in <Text> children, which
 *  destroys column alignment for edge rows. We sidestep that by rendering
 *  every space (leading or trailing) as U+00A0 NBSP, then setting an
 *  explicit Box width and wrap="truncate-end" so flex doesn't re-compute. */
const PaddedRow: React.FC<{ row: string; width: number }> = ({ row, width }) => {
  const visible = row.replace(/ /g, ' ');
  return (
    <Box width={width} flexShrink={0}>
      <Text dimColor wrap="truncate-end">{visible}</Text>
    </Box>
  );
};
