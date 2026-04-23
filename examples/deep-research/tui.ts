/**
 * Deep Research Web — TUI composition layer
 *
 * Event-driven view: one handler per concern, composed inside createView().
 * All log formatting lives here; the harness only emits plain data events.
 */

import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent } from '@lloyal-labs/lloyal-agents';
import type { PlanIntent, ResearchTask } from '@lloyal-labs/rig';
import type { OpTiming, ViewState, ViewHandler } from '../shared/tui/types';
import { c, log, emit, status, statusClear } from '../shared/tui/primitives';
import { createViewState, agentHandler, label, resetLabels } from '../shared/tui/agent-view';
import { statsHandler, completeHandler } from '../shared/tui/stats-view';
import { createGaugeState, gaugeHandler } from '../shared/tui/gauge';
import { createAgentPanel } from '../shared/tui/agent-panel';
import { tree, section } from '../shared/tui/tree';

// Re-export shared primitives for main.ts
export { c, log, setJsonlMode, setVerboseMode, fmtSize } from '../shared/tui/primitives';
export type { OpTiming } from '../shared/tui/types';

// ── Deep-research-web step events ────────────────────────

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | { type: 'plan'; intent: PlanIntent; tasks: ResearchTask[]; clarifyQuestions: string[]; tokenCount: number; timeMs: number }
  | { type: 'research:start'; agentCount: number; mode: 'flat' | 'deep' }
  | { type: 'research:done'; totalTokens: number; totalToolCalls: number; timeMs: number }
  | { type: 'fanout:tasks'; tasks: ResearchTask[] }
  | { type: 'spine:task'; taskIndex: number; taskCount: number; description: string }
  | { type: 'spine:source'; taskIndex: number; source: string }
  | { type: 'spine:task:done'; taskIndex: number; stageFindings: number; accumulated: number }
  | { type: 'synthesize:start' }
  | { type: 'synthesize:done'; agentId: number; ppl: number; tokenCount: number; toolCallCount: number; timeMs: number }
  | { type: 'verify:start'; count: number; mode: 'flat' | 'deep' }
  | { type: 'verify:done'; count: number; timeMs: number }
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
      const shape = ev.mode === 'flat' ? `flat · ${ev.agentCount} parallel` : `${ev.agentCount} agents`;
      log(section('Research') + ' ' + detail(shape));
      resetLabels(state);
    } else if (ev.type === 'research:done') {
      // Close the flat-mode panel if it was open. Chain mode has no panel;
      // no-op there. Any region still open (agent didn't emit agent:report
      // — e.g. recovery-skipped / failed) gets a default footer here.
      // `panel.finish` is idempotent against regions that already froze.
      if (state.agentPanel) {
        for (const [agentId, row] of state.agentRow) {
          const status = state.agentStatus.get(agentId);
          const tokenCount = status?.tokenCount ?? 0;
          state.agentPanel.finish(row, `${c.green}done${c.reset} · ${tokenCount} tok`);
        }
        state.agentPanel.close();
        state.agentPanel = null;
        state.agentRow.clear();
      }
      statusClear();
      log(`    ${detail(`${ev.totalTokens} tok · ${ev.totalToolCalls} tools · ${ms(ev.timeMs)}`)}`);
    }
  };
}

function fanoutHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type !== 'fanout:tasks') return;
    // Create the per-task panel. Rows = one per task, each with a scrolling
    // body showing the last 3 lines of that agent's stream + tool events.
    // From this point until research:done, all agent:* events route through
    // the panel — no other log() calls must fire during the section or the
    // cursor math breaks.
    resetLabels(state);
    state.agentPanel = createAgentPanel(
      ev.tasks.map((t: { description: string }, i: number) => ({
        title: t.description,
        label: `A${i}`,
      })),
      5,
    );
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
      const pplStr = Number.isFinite(ev.ppl) ? ` · ppl ${ev.ppl.toFixed(2)}` : '';
      log(`    ${tree.leaf} ${c.yellow}${label(state, ev.agentId)}${c.reset} ${c.green}done${c.reset} ${detail(`${ev.tokenCount} tok · ${ev.toolCallCount} tools${pplStr}`)}`);
      log(`    ${detail(`${ev.tokenCount} tok · ${ev.toolCallCount} tools · ${ms(ev.timeMs)}`)}`);
    }
  };
}

function verifyHandler(state: ViewState): ViewHandler {
  return (ev) => {
    if (ev.type === 'verify:start') {
      // Flat mode only: verify's 3 concurrent agents don't have a panel
      // yet, so their streamed output would interleave. Mute rendering
      // and show a static "Verifying..." status line until done. Deep
      // mode keeps its existing behavior (handled elsewhere or not at all).
      if (ev.mode !== 'flat') return;
      log(section('Verify') + ' ' + detail(`${ev.count} samples`));
      state.verifyMuted = true;
      status(`    ${c.dim}⠋${c.reset} ${c.dim}Verifying…${c.reset}`);
    } else if (ev.type === 'verify:done') {
      if (!state.verifyMuted) return;
      state.verifyMuted = false;
      statusClear();
      log(`    ${detail(`${ev.count} samples · ${ms(ev.timeMs)}`)}`);
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
    fanoutHandler(state),
    synthesizeHandler(state),
    verifyHandler(state),
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

