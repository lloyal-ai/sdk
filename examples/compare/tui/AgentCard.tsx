/**
 * One DAG-node card. Three rows above the body:
 *
 *   ╭─ ● <id> · <sourceLabel>             <toolChip> ─╮
 *   │ <chars> chars · <tokens> tok · <elapsed>        │   ← stats subheading (live)
 *   │ <tail line>                                     │
 *   │ ...                                             │
 *   ╰─────────────────────────────────────────────────╯
 *
 * The stats subheading is always present (with em-dashes for pending) and
 * updates live during streaming — chars and tokens accumulate, elapsed
 * ticks off `state.nowMs - node.startMs`. Done cards keep their tail
 * visible (instead of collapsing to "✓ done") so the final output stays
 * readable; the dot just flips ●→✓ and the border colors green.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { NodeRuntime } from './state';
import { colorForIndex } from './colors';
import { formatElapsed } from './hooks/useElapsed';

export interface AgentCardProps {
  node: NodeRuntime;
  width: number;
  bodyHeight: number;
  /** Wall clock in performance.now()-units, propagated from state.nowMs.
   *  Used to compute elapsed for running cards. */
  nowMs: number;
  /** Optional sub-label rendered after the node id (e.g. "web", "corpus"). */
  sourceLabel?: string;
}

export const AgentCard: React.FC<AgentCardProps> = ({
  node,
  width,
  bodyHeight,
  nowMs,
  sourceLabel,
}) => {
  const color = node.status === 'pending'
    ? 'gray'
    : node.status === 'done'
      ? 'green'
      : colorForIndex(node.colorIndex);

  return (
    <Box
      flexDirection="column"
      width={width}
      borderStyle="round"
      borderColor={color}
      flexShrink={0}
    >
      <CardHeader node={node} sourceLabel={sourceLabel} color={color} width={width - 2} />
      <CardStats node={node} nowMs={nowMs} width={width - 2} />
      <CardBody node={node} bodyHeight={bodyHeight} width={width - 2} />
    </Box>
  );
};

/** Render a fixed-width row using NBSPs so Ink's flex layout doesn't
 *  collapse trailing/leading whitespace. The row goes inside a Text with
 *  wrap="truncate-end" so width overflow doesn't reflow. */
const FixedRow: React.FC<{
  width: number;
  children: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
}> = ({ width, children, color, bold, dim }) => {
  // Pad to width with NBSP, truncate if strictly longer than width.
  let padded: string;
  if (children.length > width) {
    padded = children.slice(0, Math.max(0, width - 1)) + '…';
  } else {
    padded = children + ' '.repeat(width - children.length);
  }
  // Replace ASCII spaces with NBSP so Ink preserves them.
  const protectedRow = padded.replace(/ /g, ' ');
  return (
    <Box width={width} flexShrink={0}>
      <Text color={color} bold={bold} dimColor={dim} wrap="truncate-end">
        {protectedRow}
      </Text>
    </Box>
  );
};

const CardHeader: React.FC<{
  node: NodeRuntime;
  sourceLabel?: string;
  color: string;
  width: number;
}> = ({ node, sourceLabel, color, width }) => {
  const dot =
    node.status === 'done' ? '✓' :
    node.status === 'running' ? '●' : '·';

  const left = sourceLabel
    ? `${dot} ${node.id} · ${sourceLabel}`
    : `${dot} ${node.id}`;

  const right = node.status === 'running' && node.toolCalls > 0
    ? `●${node.toolCalls}${node.lastTool ? ' ' + truncate(node.lastTool, 12) : ''}`
    : '';

  // Compose: " <left><pad><right> ".
  const inner = width - 2; // 1-col pad on each side
  const rightTrimmed = truncate(right, Math.max(0, Math.floor(inner / 2)));
  const leftMax = Math.max(0, inner - rightTrimmed.length - 1);
  const leftTrimmed = truncate(left, leftMax);
  const padCount = Math.max(0, inner - leftTrimmed.length - rightTrimmed.length);
  const composed = ` ${leftTrimmed}${' '.repeat(padCount)}${rightTrimmed} `;

  return (
    <FixedRow width={width} color={color} bold>
      {composed}
    </FixedRow>
  );
};

const CardStats: React.FC<{
  node: NodeRuntime;
  nowMs: number;
  width: number;
}> = ({ node, nowMs, width }) => {
  if (node.status === 'pending') {
    return <FixedRow width={width} dim>{' — chars · — tok · 00:00'}</FixedRow>;
  }
  const elapsedMs = node.startMs === undefined
    ? 0
    : (node.endMs ?? nowMs) - node.startMs;
  const elapsed = formatElapsed(Math.max(0, elapsedMs));
  return (
    <FixedRow width={width} dim>
      {` ${node.charsProduced} chars · ${node.tokens} tok · ${elapsed}`}
    </FixedRow>
  );
};

const CardBody: React.FC<{
  node: NodeRuntime;
  bodyHeight: number;
  width: number;
}> = ({ node, bodyHeight, width }) => {
  const lines: string[] = [];

  if (node.status === 'pending') {
    while (lines.length < bodyHeight) {
      lines.push(' ' + '·'.repeat(width - 2));
    }
  } else {
    // running and done: render the tail, bottom-aligned. The cursor on the
    // last line marks an in-flight stream; done cards drop it.
    const tail = node.tail.slice(-bodyHeight);
    const padding = Math.max(0, bodyHeight - tail.length);
    for (let i = 0; i < padding; i++) lines.push('');
    for (let i = 0; i < tail.length; i++) {
      const isLast = i === tail.length - 1;
      const txt = ' ' + (tail[i] || '');
      lines.push(isLast && node.status === 'running' ? txt + '▮' : txt);
    }
  }

  return (
    <Box flexDirection="column" height={bodyHeight}>
      {lines.slice(0, bodyHeight).map((line, i) => (
        <FixedRow key={i} width={width} dim={node.status === 'pending'}>
          {line}
        </FixedRow>
      ))}
    </Box>
  );
};

function truncate(s: string, n: number): string {
  if (n <= 0) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
