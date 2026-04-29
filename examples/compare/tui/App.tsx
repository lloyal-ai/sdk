/**
 * Top-level Ink component for the compare TUI.
 *
 * Layout:
 *
 *   ┌ DAG · X vs Y · 0:32 ──────────────────────┐
 *   │ 1840 tok · 18 tools                       │
 *   └───────────────────────────────────────────┘
 *
 *   <DagCanvas/>      ← topology with live cards
 *
 *   <FinalAnswer/>    ← shown only after the sink reports
 */

import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useEventStream } from './hooks/useEventStream';
import { useElapsed, formatElapsed, useTerminalSize } from './hooks/useElapsed';
import { DagCanvas } from './DagCanvas';
import type { AppState } from './state';
import type { EventBus } from './event-bus';
import type { WorkflowEvent } from './events';

export interface AppProps {
  bus: EventBus<WorkflowEvent>;
  bootstrap?: WorkflowEvent[];
  /** Subjects for the header. */
  x: string;
  y: string;
  /** Human source labels per node id (web/corpus/etc.). */
  sourceLabels?: Record<string, string>;
}

export const App: React.FC<AppProps> = ({ bus, bootstrap = [], x, y, sourceLabels }) => {
  const state = useEventStream(bus, bootstrap);
  const [cols] = useTerminalSize();

  // Wall-clock anchor: snap to Date.now() when topology arrives. We DON'T
  // use state.t0Ms directly because the harness emits performance.now()
  // values for it (relative to process start, not unix epoch).
  const [anchor, setAnchor] = useState<number | null>(null);
  useEffect(() => {
    if (state.t0Ms !== null && anchor === null) setAnchor(Date.now());
  }, [state.t0Ms, anchor]);
  const active = anchor !== null && state.finalAnswer === null;
  const elapsed = useElapsed(anchor ?? Date.now(), active);

  const activeAgents = countActive(state);

  return (
    <Box flexDirection="column">
      <Header
        x={x}
        y={y}
        elapsedMs={elapsed}
        tokens={state.totalTokens}
        toolCalls={state.totalToolCalls}
        kvCellsUsed={state.kvCellsUsed}
        kvNCtx={state.kvNCtx}
        activeAgents={activeAgents}
        cols={cols}
      />
      <DagCanvas state={state} cols={cols} sourceLabels={sourceLabels} />
      {state.fatalError !== null ? (
        <ErrorPanel
          message={state.fatalError.message}
          stack={state.fatalError.stack}
          cols={cols}
        />
      ) : state.finalAnswer !== null ? (
        <FinalAnswer text={state.finalAnswer} cols={cols} />
      ) : null}
    </Box>
  );
};

function countActive(state: AppState): number {
  let n = 0;
  for (const node of state.nodes.values()) if (node.status === 'running') n++;
  return n;
}

const ErrorPanel: React.FC<{ message: string; stack?: string; cols: number }> = ({
  message,
  stack,
  cols,
}) => (
  <Box
    flexDirection="column"
    borderStyle="round"
    borderColor="red"
    paddingX={1}
    marginTop={1}
    width={cols - 1}
  >
    <Text color="red" bold>✗ fatal error</Text>
    <Text>{message}</Text>
    {stack && (
      <Text dimColor>
        {stack.split('\n').slice(0, 4).join('\n')}
      </Text>
    )}
  </Box>
);

const Header: React.FC<{
  x: string;
  y: string;
  elapsedMs: number;
  tokens: number;
  toolCalls: number;
  kvCellsUsed: number;
  kvNCtx: number;
  activeAgents: number;
  cols: number;
}> = ({ x, y, elapsedMs, tokens, toolCalls, kvCellsUsed, kvNCtx, activeAgents, cols }) => {
  const title = `DAG · ${truncate(x, 32)} vs ${truncate(y, 32)} · ${formatElapsed(elapsedMs)}`;
  const pct = kvNCtx > 0 ? Math.round((kvCellsUsed / kvNCtx) * 100) : 0;
  const gauge = gaugeBar(pct);
  const gaugeC = gaugeColor(pct);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} marginBottom={1} width={cols - 1}>
      <Text bold>{title}</Text>
      <Box flexDirection="row">
        <Text dimColor>KV </Text>
        <Text color={gaugeC}>{gauge}</Text>
        <Text> {String(pct).padStart(2, ' ')}%</Text>
        <Text dimColor> · </Text>
        <Text>{tokens} tok</Text>
        <Text dimColor> · </Text>
        <Text>{toolCalls} tools</Text>
        <Text dimColor> · </Text>
        <Text>{activeAgents} active</Text>
      </Box>
    </Box>
  );
};

function gaugeBar(pct: number, width = 12): string {
  const filled = Math.min(width, Math.max(0, Math.round((pct / 100) * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

function gaugeColor(pct: number): string {
  if (pct >= 90) return 'red';
  if (pct >= 70) return 'yellow';
  return 'green';
}

const FinalAnswer: React.FC<{ text: string; cols: number }> = ({ text, cols }) => (
  <Box flexDirection="column" borderStyle="round" borderColor="green" paddingX={1} marginTop={1} width={cols - 1}>
    <Text color="green" bold>✓ synthesis</Text>
    <Text>{text}</Text>
  </Box>
);

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
