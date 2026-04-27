/**
 * Stable color assignment per node index. The DAG canvas paints each
 * agent card's border in a node-stable color so the reader can track a
 * specific lane visually as it streams.
 */

export const agentColors = ['cyan', 'yellow', 'green', 'magenta', 'red', 'blue'] as const;

export function colorForIndex(idx: number): string {
  if (!Number.isFinite(idx) || idx < 0) return agentColors[0];
  return agentColors[idx % agentColors.length];
}
