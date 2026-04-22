/**
 * Deep Research Web — TUI composition layer
 *
 * Event-driven view: one handler per concern, composed inside createView().
 * All log formatting lives here; the harness only emits plain data events.
 */

import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent, AgentPoolResult } from '@lloyal-labs/lloyal-agents';
import type { PlanIntent, ResearchTask } from '@lloyal-labs/rig';
import type { OpTiming, ViewState, ViewHandler } from '../shared/tui/types';
import { c, log, emit, statusClear } from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';
import { statsHandler, completeHandler } from '../shared/tui/stats-view';
import { createGaugeState, gaugeHandler } from '../shared/tui/gauge';
import { tree, section } from '../shared/tui/tree';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── Deep-research-web step events ────────────────────────

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | { type: 'plan'; intent: PlanIntent; tasks: ResearchTask[]; clarifyQuestions: string[]; tokenCount: number; timeMs: number }
  | { type: 'research:start'; agentCount: number }
  | { type: 'research:done'; totalTokens: number; totalToolCalls: number; timeMs: number }
  | { type: 'spine:task'; taskIndex: number; taskCount: number; description: string }
  | { type: 'spine:source'; taskIndex: number; source: string }
  | { type: 'spine:task:done'; taskIndex: number; stageFindings: number; accumulated: number }
  | { type: 'synthesize:start' }
  | { type: 'synthesize:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'eval:done'; converged: boolean | null; tokenCount: number; sampleCount: number; timeMs: number }
  | { type: 'answer'; text: string }
  | { type: 'stats'; timings: OpTiming[]; kvLine?: string; ctxPct: number; ctxPos: number; ctxTotal: number }
  | { type: 'complete'; data: Record<string, unknown> };

export type WorkflowEvent = AgentEvent | StepEvent;

// ── Formatting helpers ───────────────────────────────────

const ms = (t: number): string => `${(t / 1000).toFixed(1)}s`;
const detail = (text: string): string => `${c.dim}${text}${c.reset}`;

// ── Handlers ─────────────────────────────────────────────

function queryHandler(state: ViewState, opts: ViewOpts): ViewHandler {
  return (ev) => {
    if (ev.type !== 'query') return;
    state.traceQuery = ev.query;
    if (ev.warm) return;
    emit('start', {
      model: opts.model, reranker: opts.reranker, query: ev.query,
      agentCount: opts.agentCount, verifyCount: opts.verifyCount,
    });
    log();
    log(`  ${detail('Query')}`);
    log(`  ${c.bold}${ev.query}${c.reset}`);
  };
}

function planHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'plan') return;
    emit('plan', { intent: ev.intent, tasks: ev.tasks, clarifyQuestions: ev.clarifyQuestions, planTokens: ev.tokenCount });
    log(section('Plan') + ' ' + detail(`${ev.intent} · ${ev.tokenCount} tok · ${ms(ev.timeMs)}`));
    if (ev.intent === 'clarify') {
      for (const q of ev.clarifyQuestions) log(`    ${detail('?')} ${q}`);
    } else if (ev.intent === 'research') {
      ev.tasks.forEach((t, i) => log(`    ${detail(`${i + 1}.`)} ${t.description}`));
    }
    // passthrough: no sub-items to log
  };
}

function researchSummaryHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type === 'research:start') {
      log(section('Research') + ' ' + detail(`${ev.agentCount} agents`));
      resetLabels(state);
    } else if (ev.type === 'research:done') {
      statusClear();
      log(`    ${detail(`${ev.totalTokens} tok · ${ev.totalToolCalls} tools · ${ms(ev.timeMs)}`)}`);
    }
  };
}

function spineHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type === 'spine:task') {
      log(`\n    ${detail('┌')} ${c.bold}Task ${ev.taskIndex + 1}/${ev.taskCount}${c.reset} ${detail(ev.description)}`);
      resetLabels(state);
    } else if (ev.type === 'spine:source') {
      log(`    ${detail(`│ ┌ ${ev.source}`)}`);
      resetLabels(state);
    } else if (ev.type === 'spine:task:done') {
      statusClear();
      log(`    ${detail(`└ +${ev.stageFindings} tok [accumulated: ${ev.accumulated} tok]`)}`);
    }
  };
}

function synthesizeHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type === 'synthesize:start') {
      log(section('Synthesize'));
      resetLabels(state);
      state.synthStreamed = false;
      state.synthStream.open();
      return;
    }
    if (ev.type === 'agent:produce') {
      if (state.synthStream.isOpen) state.synthStream.append(ev.text);
      return;
    }
    if (ev.type === 'synthesize:done') {
      if (state.synthStream.isOpen) {
        state.synthStream.close();
        state.synthStreamed = state.synthStream.hadContent;
        log();  // extra blank line between streamed page and stats tree
      } else {
        statusClear();
      }
      ev.pool.agents.forEach((a, i) => {
        const glyph = i === ev.pool.agents.length - 1 ? tree.leaf : tree.branch;
        const pplStr = Number.isFinite(a.ppl) ? ` · ppl ${a.ppl.toFixed(2)}` : '';
        log(`    ${glyph} ${c.yellow}${label(state, a.agentId)}${c.reset} ${c.green}done${c.reset} ${detail(`${a.tokenCount} tok · ${a.toolCallCount} tools${pplStr}`)}`);
      });
      log(`    ${detail(`${ev.pool.totalTokens} tok · ${ev.pool.totalToolCalls} tools · ${ms(ev.timeMs)}`)}`);
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
    log(section('Eval') + ' ' + detail(`${ev.sampleCount} samples · ${ev.tokenCount} tok · ${ms(ev.timeMs)}`));
    log(`    Converged: ${verdict}`);
  };
}

function answerHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type !== 'answer') return;
    // Synth phase already streamed the answer in place — skip re-render.
    if (state.synthStreamed) return;
    log(`\n  ${detail('─'.repeat(58))}\n`);
    const prose = ev.text.trim()
      .replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`)
      .split('\n').map((l) => `  ${l}`).join('\n');
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
    synthesizeHandler(state),
    evalHandler(),
    answerHandler(state),
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

