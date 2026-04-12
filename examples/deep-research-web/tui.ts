/**
 * Deep Research Web — TUI composition layer
 *
 * Same event-driven architecture as deep-research/tui.ts.
 */

import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { PlanQuestion } from '@lloyal-labs/rig';
import type { OpTiming, ViewState, ViewHandler } from '../shared/tui/types';
import {
  c, log, emit, statusClear,
} from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';
import { statsHandler, completeHandler } from '../shared/tui/stats-view';
import { createGaugeState, gaugeHandler } from '../shared/tui/gauge';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── Deep-research-web step events ────────────────────────

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | { type: 'plan'; intent: 'decompose' | 'passthrough' | 'clarify' | 'mixed'; questions: PlanQuestion[]; tokenCount: number; timeMs: number }
  | { type: 'research:start'; agentCount: number }
  | { type: 'research:done'; totalTokens: number; totalToolCalls: number; timeMs: number }
  | { type: 'spine:task'; taskIndex: number; taskCount: number; description: string }
  | { type: 'spine:source'; taskIndex: number; source: string }
  | { type: 'spine:task:done'; taskIndex: number; stageFindings: number; accumulated: number }
  | { type: 'synthesize:start' }
  | { type: 'synthesize:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'findings:eval'; converged: boolean | null; conflicts: string[]; observations: string[]; tokenCount: number; timeMs: number }
  | { type: 'eval:done'; converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number }
  | { type: 'answer'; text: string }
  | { type: 'stats'; timings: OpTiming[]; kvLine?: string; ctxPct: number; ctxPos: number; ctxTotal: number }
  | { type: 'complete'; data: Record<string, unknown> };

export type WorkflowEvent = AgentEvent | StepEvent;

// ── Handlers ─────────────────────────────────────────────

function queryHandler(state: ViewState, opts: ViewOpts): ViewHandler {
  return (ev) => {
    if (ev.type !== 'query') return;
    state.traceQuery = ev.query;
    if (!ev.warm) {
      emit('start', {
        model: opts.model, reranker: opts.reranker, query: ev.query,
        agentCount: opts.agentCount, verifyCount: opts.verifyCount,
      });
      log();
      log(`  ${c.dim}Query${c.reset}`);
      log(`  ${c.bold}${ev.query}${c.reset}`);
    }
  };
}

function planHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'plan') return;
    emit('plan', { intent: ev.intent, questions: ev.questions, planTokens: ev.tokenCount });
    log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Plan${c.reset} ${c.dim}${ev.intent} \u00b7 ${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
    let ri = 0;
    for (const q of ev.questions) {
      if (q.intent === 'clarify') {
        log(`    ${c.dim}?${c.reset} ${q.text}`);
      } else {
        log(`    ${c.dim}${++ri}.${c.reset} ${q.text}`);
      }
    }
  };
}

function researchSummaryHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'research:start': {
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Research${c.reset} ${c.dim}${ev.agentCount} agents${c.reset}`);
        resetLabels(state);
        break;
      }
      case 'research:done': {
        statusClear();
        log(`    ${c.dim}${ev.totalTokens} tok \u00b7 ${ev.totalToolCalls} tools \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
      }
    }
  };
}

function findingsEvalHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'findings:eval') return;
    if (ev.converged) {
      log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Findings Eval${c.reset} ${c.dim}converged \u00b7 ${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
    } else {
      log(`\n  ${c.yellow}\u25cf${c.reset} ${c.bold}Findings Eval${c.reset} ${c.dim}${ev.conflicts.length} conflicts \u00b7 ${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
      for (const conflict of ev.conflicts) {
        log(`    ${c.dim}\u2502${c.reset} ${conflict}`);
      }
    }
  };
}

function spineHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'spine:task':
        log(`\n    ${c.dim}\u250c${c.reset} ${c.bold}Task ${ev.taskIndex + 1}/${ev.taskCount}${c.reset} ${c.dim}${ev.description}${c.reset}`);
        resetLabels(state);
        break;
      case 'spine:source':
        log(`    ${c.dim}\u2502 \u250c ${ev.source}${c.reset}`);
        resetLabels(state);
        break;
      case 'spine:task:done':
        statusClear();
        log(`    ${c.dim}\u2514 +${ev.stageFindings} chars [accumulated: ${ev.accumulated}]${c.reset}`);
        break;
    }
  };
}

function synthesizeHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'synthesize:start':
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Synthesize${c.reset}`);
        resetLabels(state);
        break;
      case 'synthesize:done': {
        statusClear();
        ev.pool.agents.forEach((a: AgentPoolResult['agents'][number], i: number) => {
          const tree = i === ev.pool.agents.length - 1 ? '\u2514' : '\u251c';
          const pplStr = Number.isFinite(a.ppl) ? ` \u00b7 ppl ${a.ppl.toFixed(2)}` : '';
          log(`    ${c.dim}${tree}${c.reset} ${c.yellow}${label(state, a.agentId)}${c.reset} ${c.green}done${c.reset} ${c.dim}${a.tokenCount} tok \u00b7 ${a.toolCallCount} tools${pplStr}${c.reset}`);
        });
        log(`    ${c.dim}${ev.pool.totalTokens} tok \u00b7 ${ev.pool.totalToolCalls} tools \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        break;
      }
    }
  };
}

function evalHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'eval:done') return;
    emit('convergence', { converged: ev.converged, evalTokens: ev.tokenCount });
    const verdict = ev.converged === true ? `${c.green}yes${c.reset}`
      : ev.converged === false ? `${c.red}no${c.reset}`
      : `${c.yellow}unknown${c.reset}`;
    log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Eval${c.reset} ${c.dim}${ev.sampleCount} samples \u00b7 ${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
    log(`    Converged: ${verdict}`);
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
  };
}

// ── createView — composable view factory ─────────────────

export interface ViewOpts {
  model: string;
  reranker: string;
  agentCount: number;
  verifyCount: number;
}

export function createView(opts: ViewOpts) {
  const state = createViewState();
  const gauge = createGaugeState();

  const handlers: ViewHandler[] = [
    queryHandler(state, opts),
    planHandler(),
    gaugeHandler(gauge),       // update pressure before agentHandler reads it
    agentHandler(state, gauge),
    researchSummaryHandler(state),
    spineHandler(state),
    findingsEvalHandler(),
    synthesizeHandler(state),
    evalHandler(),
    answerHandler(),
    statsHandler(),
    completeHandler(),
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
