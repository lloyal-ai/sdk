/**
 * ReAct Agent — TUI composition layer
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
  c, log, emit, pad, statusClear,
} from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── React-agent step events ──────────────────────────────────────

export type StepEvent =
  | { type: 'query'; query: string }
  | { type: 'research:start' }
  | { type: 'research:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'answer'; text: string; tokenCount: number; toolCalls: number; timeMs: number; ctxPct: number; ctxPos: number; ctxTotal: number };

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

function researchHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'research:start': {
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Research${c.reset} ${c.dim}1 agent${c.reset}`);
        resetLabels(state);
        break;
      }
      case 'research:done': {
        statusClear();
        const a = ev.pool.agents[0];
        if (a) {
          const pplStr = Number.isFinite(a.ppl) ? ` \u00b7 ppl ${a.ppl.toFixed(2)}` : '';
          log(`    ${c.dim}\u2514${c.reset} ${c.yellow}${label(state, a.agentId)}${c.reset} ${c.green}done${c.reset} ${c.dim}${a.tokenCount} tok \u00b7 ${a.toolCallCount} tools${pplStr}${c.reset}`);
        }
        log(`    ${c.dim}${ev.pool.totalTokens} tok \u00b7 ${ev.pool.totalToolCalls} tools \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
      }
    }
  };
}

function answerHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'answer') return;

    log(`\n  ${c.dim}${'\u2500'.repeat(58)}${c.reset}\n`);
    const prose = ev.text.trim()
      .replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`)
      .split('\n').map((l: string) => `  ${l}`).join('\n');
    log(prose);

    // Stats
    log(`\n  ${c.dim}${'\u2501'.repeat(58)}${c.reset}`);
    const left = `Research   ${pad(ev.tokenCount, 5)} tok  ${ev.toolCalls} tools`;
    const right = `${pad((ev.timeMs / 1000).toFixed(1), 6)}s`;
    log(`  ${c.dim}${left}${' '.repeat(Math.max(1, 58 - left.length - right.length))}${right}${c.reset}`);
    log(`  ${c.dim}${'\u2501'.repeat(58)}${c.reset}`);
    const ctxStr = `ctx: ${ev.ctxPct}% (${ev.ctxPos.toLocaleString()}/${ev.ctxTotal.toLocaleString()})`;
    log(`  ${c.dim}${' '.repeat(58 - ctxStr.length)}${ctxStr}${c.reset}`);
    log();
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
    agentHandler(state),
    researchHandler(state),
    answerHandler(),
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
