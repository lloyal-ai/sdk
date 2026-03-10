/**
 * Deep Research — TUI composition layer
 *
 * View layer coupling: Channel<WorkflowEvent> is the UI abstraction boundary.
 * All runtime state — agent spawns, token production, tool calls, tool results,
 * progress, findings, completion — flows through this typed event stream. This
 * module is a terminal-specific renderer consuming that stream; a web UI would
 * subscribe to the same channel directly, mapping events to DOM updates.
 */

import * as fs from 'node:fs';
import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { OpTiming, ViewState, ViewHandler } from '../shared/tui/types';
import {
  c, log, emit, statusClear,
} from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';
import { statsHandler, completeHandler } from '../shared/tui/stats-view';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── Deep-research step events ────────────────────────────────────

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | { type: 'plan'; questions: string[]; tokenCount: number; timeMs: number }
  | { type: 'research:start'; agentCount: number }
  | { type: 'research:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'synthesize:start' }
  | { type: 'synthesize:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'eval:done'; converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number }
  | { type: 'answer'; text: string }
  | { type: 'response:start' }
  | { type: 'response:text'; text: string }
  | { type: 'response:done' }
  | { type: 'stats'; timings: OpTiming[]; kvLine?: string; ctxPct: number; ctxPos: number; ctxTotal: number }
  | { type: 'complete'; data: Record<string, unknown> };

export type WorkflowEvent = AgentEvent | StepEvent;

// ── Deep-research-specific handlers ──────────────────────────────

function queryHandler(state: ViewState, opts: ViewOpts): ViewHandler {
  return (ev) => {
    if (ev.type !== 'query') return;
    state.traceQuery = ev.query;
    if (!ev.warm) {
      emit('start', {
        model: opts.model, reranker: opts.reranker, query: ev.query,
        agentCount: opts.agentCount, verifyCount: opts.verifyCount, chunks: opts.chunkCount,
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
    emit('plan', { questions: ev.questions, planTokens: ev.tokenCount });
    log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Plan${c.reset} ${c.dim}${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
    ev.questions.forEach((q: string, i: number) => log(`    ${c.dim}${i + 1}.${c.reset} ${q}`));
  };
}

function researchSummaryHandler(state: ViewState): ViewHandler {
  function flushTrace(pool: AgentPoolResult): void {
    if (!pool.agents.some(a => a.trace?.length)) return;
    const filename = `trace-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify({
      query: state.traceQuery,
      timestamp: new Date().toISOString(),
      agents: pool.agents.map(a => ({
        agentId: a.agentId, label: label(state, a.agentId),
        ppl: a.ppl, samplingPpl: a.samplingPpl,
        tokenCount: a.tokenCount, toolCallCount: a.toolCallCount,
        findings: a.findings, trace: a.trace ?? [],
      })),
    }, null, 2));
    log(`  ${c.dim}Trace written to ${filename}${c.reset}`);
  }

  return (ev) => {
    switch (ev.type) {
      case 'research:start': {
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Research${c.reset} ${c.dim}${ev.agentCount} agents${c.reset}`);
        resetLabels(state);
        break;
      }
      case 'research:done': {
        statusClear();
        ev.pool.agents.forEach((a: AgentPoolResult['agents'][number], i: number) => {
          const tree = i === ev.pool.agents.length - 1 ? '\u2514' : '\u251c';
          emit('agent_done', {
            index: i, findings: (a.findings || '').slice(0, 500),
            toolCalls: a.toolCallCount, tokenCount: a.tokenCount,
            ppl: a.ppl, samplingPpl: a.samplingPpl,
          });
          const raw = (state.agentText.get(a.agentId) ?? '').replace(/\n/g, ' ').trim();
          if (raw) log(`    ${c.dim}\u251c${c.reset} ${c.yellow}${label(state, a.agentId)}${c.reset} ${c.dim}\u25b8 ${raw.slice(0, 120)}${raw.length > 120 ? '\u2026' : ''}${c.reset}`);
          const pplStr = Number.isFinite(a.ppl) ? ` \u00b7 ppl ${a.ppl.toFixed(2)}` : '';
          log(`    ${c.dim}${tree}${c.reset} ${c.yellow}${label(state, a.agentId)}${c.reset} ${c.green}done${c.reset} ${c.dim}${a.tokenCount} tok \u00b7 ${a.toolCallCount} tools${pplStr}${c.reset}`);
        });
        log(`    ${c.dim}${ev.pool.totalTokens} tok \u00b7 ${ev.pool.totalToolCalls} tools \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        flushTrace(ev.pool);
        break;
      }
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

function responseHandler(): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'response:start':
        process.stdout.write(`  ${c.dim}<${c.reset} `);
        break;
      case 'response:text':
        process.stdout.write(ev.text);
        break;
      case 'response:done':
        console.log('\n');
        break;
    }
  };
}

// ── createView — composable view factory ─────────────────────────

export interface ViewOpts {
  model: string;
  reranker: string;
  agentCount: number;
  verifyCount: number;
  chunkCount: number;
}

export function createView(opts: ViewOpts) {
  const state = createViewState();

  const handlers: ViewHandler[] = [
    queryHandler(state, opts),
    planHandler(),
    agentHandler(state),
    researchSummaryHandler(state),
    synthesizeHandler(state),
    evalHandler(),
    answerHandler(),
    responseHandler(),
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
