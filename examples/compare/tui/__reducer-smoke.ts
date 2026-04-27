/**
 * Reducer + EdgeRow smoke test.
 *
 * No vitest dependency — runs directly under tsx as a script. Asserts that
 * the reducer keeps the expected state shape across a representative
 * sequence of events, and that the edge router produces the right glyphs
 * for the canonical fan-out / fan-in / 1↔1 cases.
 *
 *   npx tsx examples/compare/tui/__reducer-smoke.ts
 */

import { reduce } from './reducer';
import { initialState } from './state';
import type { WorkflowEvent } from './events';
import { routeEdges, type EdgeEndpoint } from './edge-router';

let failed = 0;
function assert(cond: unknown, label: string): void {
  if (cond) {
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    process.stdout.write(`  ✗ ${label}\n`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, label: string): void {
  assert(JSON.stringify(actual) === JSON.stringify(expected), `${label} → ${JSON.stringify(actual)}`);
}

// ─────────────────────────────────────────────────────────────────
// Reducer
// ─────────────────────────────────────────────────────────────────

process.stdout.write('reducer\n');

const TOPOLOGY: WorkflowEvent = {
  type: 'dag:topology',
  t0Ms: 1000,
  nodes: [
    { id: 'web', dependsOn: [] },
    { id: 'corpus', dependsOn: [] },
    { id: 'cmp_a', dependsOn: ['web', 'corpus'] },
    { id: 'cmp_b', dependsOn: ['web', 'corpus'] },
    { id: 'synth', dependsOn: ['cmp_a', 'cmp_b'] },
  ],
};

let s = reduce(initialState, TOPOLOGY);
assert(s.topology !== null, 'topology seeded');
eq(s.topology!.layers, [['web', 'corpus'], ['cmp_a', 'cmp_b'], ['synth']], 'three topo layers');
assert(s.nodes.size === 5, 'all 5 nodes present');
assert([...s.nodes.values()].every((n) => n.status === 'pending'), 'all pending initially');
eq(s.t0Ms, 1000, 't0Ms set');

s = reduce(s, { type: 'dag:node:spawn', id: 'web', agentId: 7, tMs: 1100 });
assert(s.nodes.get('web')!.status === 'running', 'web running after spawn');
eq(s.nodes.get('web')!.agentId, 7, 'web agent id captured');
eq(s.agentToNode.get(7), 'web', 'agentToNode reverse lookup populated');

// `tokenCount` on agent:produce is the agent's running cumulative count
// (see packages/agents/src/agent-pool.ts:1002-1008), not a per-event delta.
// The reducer must REPLACE the node's tokens, not sum, and derive
// totalTokens by adding only positive deltas across agents.
s = reduce(s, { type: 'agent:produce', agentId: 7, text: 'searching for', tokenCount: 3 });
s = reduce(s, { type: 'agent:produce', agentId: 7, text: ' rust ownership', tokenCount: 5 });
eq(s.nodes.get('web')!.tail, ['searching for rust ownership'], 'tail extends last line');
eq(s.nodes.get('web')!.tokens, 5, 'tokens take the latest cumulative value');
eq(s.totalTokens, 5, 'totalTokens sums per-agent deltas');

s = reduce(s, { type: 'agent:produce', agentId: 7, text: '\nfetching pages', tokenCount: 7 });
eq(s.nodes.get('web')!.tail, ['searching for rust ownership', 'fetching pages'], 'newline starts a new tail line');
eq(s.nodes.get('web')!.tokens, 7, 'tokens advance with the cumulative count');
eq(s.totalTokens, 7, 'totalTokens accumulates only the delta');

s = reduce(s, {
  type: 'agent:tool_call',
  agentId: 7,
  tool: 'web_search',
  args: '{"query":"rust ownership memory"}',
});
const webTail = s.nodes.get('web')!.tail;
assert(webTail[webTail.length - 1].startsWith('→ web_search'), 'tool_call appends arrow chip');
eq(s.nodes.get('web')!.toolCalls, 1, 'toolCalls increments');
eq(s.nodes.get('web')!.lastTool, 'web_search', 'lastTool tracked');
eq(s.totalToolCalls, 1, 'totalToolCalls accumulates');

s = reduce(s, { type: 'agent:report', agentId: 7, result: 'Findings on Rust ownership.' });
assert(s.nodes.get('web')!.status === 'done', 'web flips to done on report');
eq(s.nodes.get('web')!.reportChars, 'Findings on Rust ownership.'.length, 'reportChars stamped');
eq(s.finalAnswer, null, 'web is not the sink — finalAnswer stays null');

// Spawn the sink directly to verify finalAnswer routing.
const TOPO_2: WorkflowEvent = {
  type: 'dag:topology',
  t0Ms: 0,
  nodes: [{ id: 'a', dependsOn: [] }, { id: 'b', dependsOn: ['a'] }],
};
let s2 = reduce(initialState, TOPO_2);
s2 = reduce(s2, { type: 'dag:node:spawn', id: 'b', agentId: 99, tMs: 50 });
s2 = reduce(s2, { type: 'agent:report', agentId: 99, result: 'final.' });
eq(s2.finalAnswer, 'final.', 'sink report populates finalAnswer');

// charsProduced accumulates over agent:produce events.
eq(s.nodes.get('web')!.charsProduced,
   'searching for'.length + ' rust ownership'.length + '\nfetching pages'.length,
   'charsProduced sums ev.text.length');

// agent:tick captures KV pressure for the header gauge.
const sTick = reduce(s, { type: 'agent:tick', cellsUsed: 1024, nCtx: 32768 });
eq(sTick.kvCellsUsed, 1024, 'agent:tick stores cellsUsed');
eq(sTick.kvNCtx, 32768, 'agent:tick stores nCtx');

// Fatal error event — TUI keeps state, just surfaces the error.
let s3 = reduce(s, {
  type: 'compare:error',
  message: 'pool exploded',
  stack: 'Error: pool exploded\n  at handleCompare:42',
});
assert(s3.fatalError !== null, 'compare:error sets fatalError');
eq(s3.fatalError!.message, 'pool exploded', 'fatalError carries message');
assert(s3.nodes.size === s.nodes.size, 'compare:error preserves nodes');
assert(s3.totalTokens === s.totalTokens, 'compare:error preserves running counts');

// ─────────────────────────────────────────────────────────────────
// EdgeRow router
// ─────────────────────────────────────────────────────────────────

process.stdout.write('\nedge router\n');

function chars(s: string): string {
  // visualize whitespace
  return s.replace(/ /g, '·');
}

// 1 → 1: three vertical pipes
{
  const parents: EdgeEndpoint[] = [{ id: 'p', col: 5 }];
  const children: EdgeEndpoint[] = [{ id: 'c', col: 5 }];
  const { rows } = routeEdges(parents, children, [['p', 'c']], 12);
  process.stdout.write(`  1↔1 row0 [${chars(rows[0])}]\n`);
  process.stdout.write(`       row1 [${chars(rows[1])}]\n`);
  process.stdout.write(`       row2 [${chars(rows[2])}]\n`);
  assert(rows[0][5] === '│', '1↔1 row0 has │ at col 5');
  // When source=target col, busLeft=busRight=5; rounding logic ends up with
  // either ┴ → ╰ or ┬ → ╭ depending on which branch fires first. Either way
  // it must be a non-bus character.
  const mid = rows[1][5];
  assert(mid !== '─' && mid !== ' ', `1↔1 row1[5] is a corner glyph (got ${mid})`);
  assert(rows[2][5] === '│', '1↔1 row2 has │ at col 5');
}

// 2 → 3: fan-out (mirrors compare's research → compares)
{
  const parents: EdgeEndpoint[] = [
    { id: 'p1', col: 10 },
    { id: 'p2', col: 30 },
  ];
  const children: EdgeEndpoint[] = [
    { id: 'c1', col: 8 },
    { id: 'c2', col: 20 },
    { id: 'c3', col: 32 },
  ];
  const edges: [string, string][] = [
    ['p1', 'c1'], ['p1', 'c2'], ['p1', 'c3'],
    ['p2', 'c1'], ['p2', 'c2'], ['p2', 'c3'],
  ];
  const { rows } = routeEdges(parents, children, edges, 50);
  process.stdout.write(`  2→3 row0 [${chars(rows[0])}]\n`);
  process.stdout.write(`       row1 [${chars(rows[1])}]\n`);
  process.stdout.write(`       row2 [${chars(rows[2])}]\n`);
  assert(rows[0][10] === '│' && rows[0][30] === '│', 'fan-out row0 drops at parent cols');
  assert(rows[1][10] === '┴' && rows[1][30] === '┴', 'fan-out row1 has ┴ at parents');
  // leftmost involved col (8) is a child → ╭ ; rightmost (32) is also a child → ╮
  assert(rows[1][8] === '╭', 'leftmost end is rounded child corner ╭');
  assert(rows[1][32] === '╮', 'rightmost end is rounded child corner ╮');
  assert(rows[1][20] === '┬', 'middle child has ┬ tee');
  assert(rows[2][8] === '│' && rows[2][20] === '│' && rows[2][32] === '│', 'row2 drops at child cols');
}

// 3 → 1: fan-in
{
  const parents: EdgeEndpoint[] = [
    { id: 'p1', col: 8 },
    { id: 'p2', col: 20 },
    { id: 'p3', col: 32 },
  ];
  const children: EdgeEndpoint[] = [{ id: 'c', col: 20 }];
  const edges: [string, string][] = [['p1', 'c'], ['p2', 'c'], ['p3', 'c']];
  const { rows } = routeEdges(parents, children, edges, 50);
  process.stdout.write(`  3→1 row0 [${chars(rows[0])}]\n`);
  process.stdout.write(`       row1 [${chars(rows[1])}]\n`);
  process.stdout.write(`       row2 [${chars(rows[2])}]\n`);
  assert(rows[0][8] === '│' && rows[0][20] === '│' && rows[0][32] === '│', 'fan-in row0 drops from each parent');
  assert(rows[1][20] === '┼', 'middle col is both source and target → ┼');
  assert(rows[1][8] === '╰' && rows[1][32] === '╯', 'fan-in bus ends rounded');
  assert(rows[2][20] === '│', 'fan-in row2 drops into child');
}

if (failed > 0) {
  process.stderr.write(`\nFAILED: ${failed} assertion(s)\n`);
  process.exit(1);
}
process.stdout.write('\nall smokes passed\n');
