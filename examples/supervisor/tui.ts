/**
 * Supervisor — TUI composition layer
 *
 * View layer coupling: Channel<WorkflowEvent> is the UI abstraction boundary.
 * All runtime state flows through this typed event stream. This module is a
 * terminal-specific renderer; a web UI would subscribe to the same channel
 * directly.
 */

import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { OpTiming, ViewState, ViewHandler } from '../shared/tui/types';
import {
  c, log, statusClear,
} from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';
import { statsHandler } from '../shared/tui/stats-view';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── Supervisor step events ───────────────────────────────────────

export type StepEvent =
  | { type: 'query'; query: string }
  | { type: 'classify:start' }
  | { type: 'classify:done'; routes: string[]; rationale: string; tokenCount: number; timeMs: number }
  | { type: 'dispatch:start'; routes: string[] }
  | { type: 'dispatch:done'; pool: AgentPoolResult; routes: string[]; timeMs: number }
  | { type: 'synthesize:start' }
  | { type: 'synthesize:text'; text: string }
  | { type: 'synthesize:done'; tokenCount: number; timeMs: number }
  | { type: 'stats'; timings: OpTiming[]; ctxPct: number; ctxPos: number; ctxTotal: number };

export type WorkflowEvent = AgentEvent | StepEvent;

// ── Handlers ─────────────────────────────────────────────────────

function queryHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'query') return;
    log();
    log(`  ${c.dim}Query${c.reset}`);
    log(`  ${c.bold}${ev.query}${c.reset}`);
  };
}

function classifyHandler(): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'classify:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Classify${c.reset} ${c.dim}grammar-constrained routing${c.reset}`);
        break;
      case 'classify:done':
        log(`    Routes: ${ev.routes.map((r: string) => `${c.cyan}${r}${c.reset}`).join(', ')}`);
        log(`    ${c.dim}${ev.rationale}${c.reset}`);
        log(`    ${c.dim}${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
    }
  };
}

function dispatchHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'dispatch:start': {
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Dispatch${c.reset} ${c.dim}${ev.routes.length} specialists${c.reset}`);
        resetLabels(state);
        break;
      }
      case 'dispatch:done': {
        statusClear();
        ev.pool.agents.forEach((a: AgentPoolResult['agents'][number], i: number) => {
          const tree = i === ev.pool.agents.length - 1 ? '\u2514' : '\u251c';
          const pplStr = Number.isFinite(a.ppl) ? ` \u00b7 ppl ${a.ppl.toFixed(2)}` : '';
          const role = ev.routes[i] ? ` [${ev.routes[i]}]` : '';
          log(`    ${c.dim}${tree}${c.reset} ${c.yellow}${label(state, a.agentId)}${c.reset}${c.cyan}${role}${c.reset} ${c.green}done${c.reset} ${c.dim}${a.tokenCount} tok \u00b7 ${a.toolCallCount} tools${pplStr}${c.reset}`);
        });
        log(`    ${c.dim}${ev.pool.totalTokens} tok \u00b7 ${ev.pool.totalToolCalls} tools \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
      }
    }
  };
}

function synthesizeHandler(): ViewHandler {
  let charCount = 0;
  return (ev) => {
    switch (ev.type) {
      case 'synthesize:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Synthesize${c.reset}`);
        log(`\n  ${c.dim}${'\u2500'.repeat(58)}${c.reset}\n`);
        process.stdout.write('  ');
        charCount = 0;
        break;
      case 'synthesize:text':
        process.stdout.write(ev.text);
        charCount += ev.text.length;
        break;
      case 'synthesize:done':
        if (charCount > 0) process.stdout.write('\n');
        break;
    }
  };
}

// ── createView ───────────────────────────────────────────────────

export interface ViewOpts {
  model: string;
  reranker: string;
  chunkCount: number;
}

export function createView(opts: ViewOpts) {
  const state = createViewState();

  const handlers: ViewHandler[] = [
    queryHandler(),
    classifyHandler(),
    agentHandler(state),
    dispatchHandler(state),
    synthesizeHandler(),
    statsHandler(),
  ];

  return {
    *subscribe(events: Channel<WorkflowEvent, void>): Operation<void> {
      for (const ev of yield* each(events)) {
        for (const h of handlers) h(ev);
        yield* each.next();
      }
    },
  };
}
