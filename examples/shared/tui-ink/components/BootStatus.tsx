/**
 * Boot-phase status view. Rendered while uiPhase is 'downloading' or
 * 'loading'. Reuses the same spinner pattern as <PlanningSpinner> — one
 * look across the whole app.
 *
 *   ⠋ Downloading models
 *     ● Qwen3.5-4B Q4_K_M   ████████░░░░  42% · 1.1 GB / 2.6 GB
 *     ● Qwen3-Reranker 0.6B Q8_0  (queued)
 *
 *   ⠋ Loading weights…
 */

import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { AppState, DownloadStatus } from '../state';
import { SPINNER_FRAMES, SPINNER_TICK_MS } from '../spinner-frames';

export const BootStatus = memo(function BootStatus({
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

  if (state.uiPhase === 'downloading') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box>
          <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
          <Text bold>Downloading models</Text>
        </Box>
        {state.downloads.map((d) => (
          <DownloadLine key={d.id} item={d} />
        ))}
      </Box>
    );
  }

  // uiPhase === 'loading'
  return (
    <Box marginBottom={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]} </Text>
      <Text bold>{state.loadingLabel ?? 'Loading…'}</Text>
    </Box>
  );
});

const DownloadLine = memo(function DownloadLine({
  item,
}: {
  item: DownloadStatus;
}): React.ReactElement {
  const pct = item.total > 0 ? Math.min(100, Math.floor((item.got / item.total) * 100)) : 0;
  const width = 20;
  const filled = Math.floor((pct / 100) * width);
  const bar = '█'.repeat(filled) + '░'.repeat(width - filled);

  return (
    <Box paddingLeft={2}>
      <Text color={item.done ? 'green' : 'cyan'}>{item.done ? '✓ ' : '● '}</Text>
      <Text>{item.label.padEnd(30)}  </Text>
      {item.done ? (
        <Text dimColor>{fmtBytes(item.got)}</Text>
      ) : (
        <>
          <Text color="cyan">{bar}</Text>
          <Text>  {String(pct).padStart(2)}% · {fmtBytes(item.got)} / {fmtBytes(item.total)}</Text>
        </>
      )}
    </Box>
  );
});

function fmtBytes(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + ' GB';
  if (n >= 1e6) return (n / 1e6).toFixed(0) + ' MB';
  if (n >= 1e3) return (n / 1e3).toFixed(0) + ' KB';
  return `${n} B`;
}
