/**
 * Reflection — TUI composition layer
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

// ── Reflection step events ───────────────────────────────────────

export type StepEvent =
  | { type: 'query'; query: string }
  | { type: 'research:start' }
  | { type: 'research:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'draft:start' }
  | { type: 'draft:text'; text: string }
  | { type: 'draft:done'; tokenCount: number; timeMs: number }
  | { type: 'critique:start'; attempts: number }
  | { type: 'critique:done'; output: string; attempts: number; tokenCount: number; timeMs: number }
  | { type: 'revise:start' }
  | { type: 'revise:text'; text: string }
  | { type: 'revise:done'; tokenCount: number; timeMs: number }
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

function draftHandler(): ViewHandler {
  let charCount = 0;
  return (ev) => {
    switch (ev.type) {
      case 'draft:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Draft${c.reset}`);
        process.stdout.write(`    ${c.dim}`);
        charCount = 0;
        break;
      case 'draft:text':
        process.stdout.write(ev.text);
        charCount += ev.text.length;
        break;
      case 'draft:done':
        if (charCount > 0) process.stdout.write(`${c.reset}\n`);
        log(`    ${c.dim}${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
    }
  };
}

function critiqueHandler(): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'critique:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Critique${c.reset} ${c.dim}${ev.attempts} attempts (perplexity selection)${c.reset}`);
        break;
      case 'critique:done': {
        const cols = process.stdout.columns || 80;
        const wrap = cols - 8;
        const lines = ev.output.trim().split('\n');
        for (const line of lines.slice(0, 8)) {
          const text = line.trim();
          if (!text) continue;
          const display = text.length > wrap ? text.slice(0, wrap) + '\u2026' : text;
          log(`    ${c.dim}${display}${c.reset}`);
        }
        if (lines.length > 8) log(`    ${c.dim}\u2026 ${lines.length - 8} more lines${c.reset}`);
        log(`    ${c.dim}${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
      }
    }
  };
}

function reviseHandler(): ViewHandler {
  let charCount = 0;
  return (ev) => {
    switch (ev.type) {
      case 'revise:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Revise${c.reset}`);
        log(`\n  ${c.dim}${'\u2500'.repeat(58)}${c.reset}\n`);
        process.stdout.write('  ');
        charCount = 0;
        break;
      case 'revise:text':
        process.stdout.write(ev.text);
        charCount += ev.text.length;
        break;
      case 'revise:done':
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
    agentHandler(state),
    researchHandler(state),
    draftHandler(),
    critiqueHandler(),
    reviseHandler(),
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
