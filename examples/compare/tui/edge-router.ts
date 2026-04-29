/**
 * Edge router — pure function. Lives in its own file (no Ink/React imports)
 * so the smoke tests can call it without dragging yoga-wasm-web into the
 * CJS module graph.
 */

export interface EdgeEndpoint {
  id: string;
  col: number;
}

export interface EdgeRouteResult {
  rows: [string, string, string];
}

export function routeEdges(
  parents: EdgeEndpoint[],
  children: EdgeEndpoint[],
  edges: [string, string][],
  width: number,
): EdgeRouteResult {
  const parentByCol = new Map(parents.map((p) => [p.id, p.col]));
  const childByCol = new Map(children.map((c) => [c.id, c.col]));

  const sourceCols = new Set<number>();
  const targetCols = new Set<number>();
  for (const [from, to] of edges) {
    const sc = parentByCol.get(from);
    const tc = childByCol.get(to);
    if (sc === undefined || tc === undefined) continue;
    sourceCols.add(sc);
    targetCols.add(tc);
  }

  const rows: string[][] = [
    Array.from({ length: width }, () => ' '),
    Array.from({ length: width }, () => ' '),
    Array.from({ length: width }, () => ' '),
  ];

  if (sourceCols.size === 0 && targetCols.size === 0) {
    return { rows: [rows[0].join(''), rows[1].join(''), rows[2].join('')] };
  }

  const involved = [...sourceCols, ...targetCols];
  const busLeft = Math.max(0, Math.min(...involved));
  const busRight = Math.min(width - 1, Math.max(...involved));

  for (const c of sourceCols) {
    if (c >= 0 && c < width) rows[0][c] = '│';
  }

  for (let c = busLeft; c <= busRight; c++) rows[1][c] = '─';
  for (const c of sourceCols) {
    if (c < 0 || c >= width) continue;
    rows[1][c] = targetCols.has(c) ? '┼' : '┴';
  }
  for (const c of targetCols) {
    if (c < 0 || c >= width) continue;
    if (rows[1][c] === '┼') continue;
    rows[1][c] = '┬';
  }
  // Round the bus ends.
  if (rows[1][busLeft] === '─') rows[1][busLeft] = '╭';
  else if (rows[1][busLeft] === '┴') rows[1][busLeft] = '╰';
  else if (rows[1][busLeft] === '┬') rows[1][busLeft] = '╭';
  if (rows[1][busRight] === '─') rows[1][busRight] = '╮';
  else if (rows[1][busRight] === '┴') rows[1][busRight] = '╯';
  else if (rows[1][busRight] === '┬') rows[1][busRight] = '╮';

  for (const c of targetCols) {
    if (c >= 0 && c < width) rows[2][c] = '│';
  }

  return {
    rows: [rows[0].join(''), rows[1].join(''), rows[2].join('')],
  };
}
