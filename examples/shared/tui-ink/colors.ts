/**
 * Stable color assignment per agent label ("A0", "A1", …).
 * Components use this to keep an agent's section header, status dot, and
 * source chips visually consistent across the TUI.
 */

export const agentColors = ['cyan', 'yellow', 'green', 'magenta', 'red', 'blue'] as const;

export function colorForLabel(label: string): string {
  const n = Number.parseInt(label.slice(1), 10);
  if (!Number.isFinite(n) || n < 0) return agentColors[0];
  return agentColors[n % agentColors.length];
}

export function colorForTaskIndex(idx: number | null): string {
  if (idx === null) return 'white';
  return agentColors[idx % agentColors.length];
}
