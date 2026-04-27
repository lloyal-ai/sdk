/**
 * Returns elapsed ms since `startedAt`, refreshing every 250ms while active.
 * Used by the footer to render a live clock without firing React updates
 * for every agent:produce event.
 */

import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export function useTerminalSize(): [number, number] {
  const { stdout } = useStdout();
  const [size, setSize] = useState<[number, number]>(() => [
    stdout?.columns ?? 120,
    stdout?.rows ?? 40,
  ]);

  useEffect(() => {
    if (!stdout) return;
    const onResize = (): void => {
      setSize([stdout.columns ?? 120, stdout.rows ?? 40]);
    };
    stdout.on('resize', onResize);
    return () => { stdout.off('resize', onResize); };
  }, [stdout]);

  return size;
}

export function useElapsed(startedAt: number, active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return Math.max(0, now - startedAt);
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
