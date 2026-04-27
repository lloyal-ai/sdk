/**
 * Visual smoke for the compare TUI. Drives a synthetic event sequence that
 * walks through:
 *
 *   t=0       — topology arrives, all nodes pending
 *   t=200ms   — root nodes (web, corpus) spawn
 *   t=600ms   — both roots stream a few tokens + tool calls
 *   t=1500ms  — both roots report; layer 1 (3 compares) spawns
 *   t=2200ms  — compares stream
 *   t=3200ms  — compares report; synth spawns
 *   t=4200ms  — synth streams + reports → finalAnswer panel renders
 *
 *   npx tsx examples/compare/tui/__visual-smoke.tsx
 */

import { createBus } from './event-bus';
import type { WorkflowEvent } from './events';
import { render } from './render';

const bus = createBus<WorkflowEvent>();

const TOPOLOGY: { id: string; dependsOn: string[] }[] = [
  { id: 'research_web_X', dependsOn: [] },
  { id: 'research_corp_Y', dependsOn: [] },
  { id: 'compare_axis_1', dependsOn: ['research_web_X', 'research_corp_Y'] },
  { id: 'compare_axis_2', dependsOn: ['research_web_X', 'research_corp_Y'] },
  { id: 'compare_axis_3', dependsOn: ['research_web_X', 'research_corp_Y'] },
  { id: 'synthesize', dependsOn: ['compare_axis_1', 'compare_axis_2', 'compare_axis_3'] },
];

const sourceLabels = {
  research_web_X: 'web',
  research_corp_Y: 'corpus',
  compare_axis_1: 'axis 1',
  compare_axis_2: 'axis 2',
  compare_axis_3: 'axis 3',
  synthesize: 'sink',
};

const instance = render(bus, {
  x: "Rust's ownership model",
  y: "Swift's automatic reference counting",
  sourceLabels,
});

let now = 0;
function at(ms: number, ev: WorkflowEvent): void {
  setTimeout(() => bus.send(ev), ms);
  now = Math.max(now, ms);
}

at(50, { type: 'dag:topology', t0Ms: 0, nodes: TOPOLOGY });

// Periodic KV pressure ticks — drive the header gauge. Real harnesses
// emit these from the agent-pool tick loop.
for (let t = 100; t <= 4500; t += 250) {
  const pct = Math.min(0.85, t / 6000); // creeps from 0% toward ~85%
  at(t, { type: 'agent:tick', cellsUsed: Math.round(32768 * pct), nCtx: 32768 });
}

at(200, { type: 'dag:node:spawn', id: 'research_web_X', agentId: 1, tMs: 200 });
at(200, { type: 'dag:node:spawn', id: 'research_corp_Y', agentId: 2, tMs: 200 });

// Roots stream content.
at(400, { type: 'agent:produce', agentId: 1, text: 'Searching: rust ownership memory model', tokenCount: 8 });
at(450, { type: 'agent:produce', agentId: 2, text: 'Reading examples/lifetimes.md', tokenCount: 6 });
at(700, { type: 'agent:tool_call', agentId: 1, tool: 'web_search', args: '{"query":"rust borrow checker"}' });
at(750, { type: 'agent:tool_call', agentId: 2, tool: 'grep', args: '{"pattern":"Box<T>"}' });
at(1000, { type: 'agent:tool_result', agentId: 1, tool: 'web_search', result: 'rust-lang.org/borrow.html (8 results)' });
at(1050, { type: 'agent:tool_result', agentId: 2, tool: 'grep', result: 'examples/lifetimes.md:42: Box<T> heap allocation' });
at(1200, { type: 'agent:produce', agentId: 1, text: '\nThe borrow checker enforces…', tokenCount: 10 });
at(1250, { type: 'agent:produce', agentId: 2, text: '\nARC at compile time…', tokenCount: 8 });

// Roots report; layer 1 spawns.
at(1500, { type: 'agent:report', agentId: 1, result: 'Web findings on Rust ownership across 3 fetched pages.' });
at(1550, { type: 'agent:report', agentId: 2, result: 'Corpus findings on Swift ARC from 4 file reads.' });

at(1700, { type: 'dag:node:spawn', id: 'compare_axis_1', agentId: 3, tMs: 1700 });
at(1700, { type: 'dag:node:spawn', id: 'compare_axis_2', agentId: 4, tMs: 1700 });
at(1700, { type: 'dag:node:spawn', id: 'compare_axis_3', agentId: 5, tMs: 1700 });

at(2000, { type: 'agent:produce', agentId: 3, text: 'Both prevent use-after-free…', tokenCount: 6 });
at(2050, { type: 'agent:produce', agentId: 4, text: 'Rust: zero-cost; ARC: runtime', tokenCount: 7 });
at(2100, { type: 'agent:produce', agentId: 5, text: 'Rust requires explicit lifetimes', tokenCount: 6 });

at(3000, { type: 'agent:report', agentId: 3, result: 'Axis 1 (accuracy): both correct, different costs.' });
at(3050, { type: 'agent:report', agentId: 4, result: 'Axis 2 (perf): Rust faster cold path.' });
at(3100, { type: 'agent:report', agentId: 5, result: 'Axis 3 (complexity): Swift simpler day-1.' });

at(3300, { type: 'dag:node:spawn', id: 'synthesize', agentId: 6, tMs: 3300 });
at(3700, { type: 'agent:produce', agentId: 6, text: '# Rust vs Swift: Memory Safety Through Different Trades', tokenCount: 12 });
at(3900, { type: 'agent:produce', agentId: 6, text: '\nThe two languages converge on safety…', tokenCount: 10 });
at(4500, {
  type: 'agent:report',
  agentId: 6,
  result:
    '# Rust vs Swift: Memory Safety Through Different Trades\n\n' +
    'The two languages converge on memory safety but diverge on cost: ' +
    "Rust pushes proof obligations to the developer at compile time, " +
    "while Swift's ARC defers them to runtime reference counting.",
});

setTimeout(() => {
  instance.unmount();
  process.exit(0);
}, now + 1500);
