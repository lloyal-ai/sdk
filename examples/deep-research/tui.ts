import * as fs from 'node:fs';
import { each } from 'effection';
import type { Channel, Operation } from 'effection';
import type { AgentEvent, AgentPoolResult, DivergeResult } from '@lloyal-labs/lloyal-agents';
import type { AgreementResult } from './agreement';

// ── Event types ──────────────────────────────────────────────────

export interface OpTiming {
  label: string;
  tokens: number;
  detail: string;
  timeMs: number;
}

export type StepEvent =
  | { type: 'query'; query: string; warm: boolean }
  | { type: 'plan'; questions: string[]; tokenCount: number; timeMs: number }
  | { type: 'research:start'; agentCount: number }
  | { type: 'research:done'; pool: AgentPoolResult; timeMs: number }
  | { type: 'verify:start'; count: number }
  | { type: 'verify:done'; result: DivergeResult; timeMs: number }
  | { type: 'verify:agreement'; result: AgreementResult }
  | { type: 'eval:done'; converged: boolean | null; tokenCount: number; timeMs: number }
  | { type: 'answer'; text: string }
  | { type: 'response:start' }
  | { type: 'response:text'; text: string }
  | { type: 'response:done' }
  | { type: 'stats'; timings: OpTiming[]; kvLine?: string; ctxPct: number; ctxPos: number; ctxTotal: number }
  | { type: 'complete'; data: Record<string, unknown> };

export type WorkflowEvent = AgentEvent | StepEvent;

// ── Mode + color ─────────────────────────────────────────────────

let _jsonlMode = false;
let _verboseMode = false;

export function setJsonlMode(on: boolean): void { _jsonlMode = on; }
export function setVerboseMode(on: boolean): void { _verboseMode = on; }

const isTTY = process.stdout.isTTY;

export const c = isTTY ? {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', red: '\x1b[31m',
} : { bold: '', dim: '', reset: '', green: '', cyan: '', yellow: '', red: '' };

// ── Primitives ───────────────────────────────────────────────────

let _statusText = '';

function status(text: string): void {
  if (_jsonlMode || !isTTY) return;
  _statusText = text;
  process.stdout.write('\r\x1b[K' + text);
}

function statusClear(): void {
  if (!_statusText) return;
  _statusText = '';
  process.stdout.write('\r\x1b[K');
}

export const log = (...a: unknown[]): void => {
  if (_jsonlMode) return;
  statusClear();
  console.log(...a);
};

function emit(event: string, data: Record<string, unknown>): void {
  if (_jsonlMode) console.log(JSON.stringify({ event, ...data }));
}

export const fmtSize = (bytes: number): string => bytes > 1e9
  ? (bytes / 1e9).toFixed(1) + ' GB'
  : (bytes / 1e6).toFixed(0) + ' MB';

const pad = (s: unknown, n: number): string => String(s).padStart(n);

// ── View state + handler type ────────────────────────────────────

interface ViewState {
  agentLabel: Map<number, string>;
  nextLabel: number;
  agentText: Map<number, string>;
  agentStatus: Map<number, { state: string; tokenCount: number; detail: string }>;
  agentParent: Map<number, number>;  // childId → parentId (sub-agent tracking)
  traceQuery: string;
}

type ViewHandler = (ev: WorkflowEvent) => void;

function isSubAgent(state: ViewState, agentId: number): boolean {
  return state.agentParent.has(agentId);
}

function parentLabel(state: ViewState, agentId: number): string {
  return label(state, state.agentParent.get(agentId)!);
}

function label(state: ViewState, agentId: number): string {
  let l = state.agentLabel.get(agentId);
  if (!l) { l = `A${state.nextLabel++}`; state.agentLabel.set(agentId, l); }
  return l;
}

function resetLabels(state: ViewState): void {
  state.nextLabel = 0;
  state.agentLabel.clear();
  state.agentStatus.clear();
  state.agentText.clear();
  state.agentParent.clear();
}

function renderStatus(state: ViewState): void {
  const active = [...state.agentStatus.entries()]
    .filter(([id, s]) => s.state !== 'done' && !isSubAgent(state, id));
  if (active.length === 0) return;

  const generating = active.filter(([, s]) => s.state === 'gen');
  if (generating.length === 1 && active.length === 1) {
    const [id] = generating[0];
    const raw = (state.agentText.get(id) ?? '').replace(/\n/g, ' ').trimStart();
    const cols = process.stdout.columns || 80;
    const maxLen = cols - 12;
    const text = raw.length > maxLen ? raw.slice(raw.length - maxLen) : raw;
    status(`    ${c.dim}\u25c6${c.reset} ${c.yellow}${label(state, id)}${c.reset} ${text}`);
    return;
  }

  const parts = active.map(([id, s]) => {
    const lbl = `${c.yellow}${label(state, id)}${c.reset}`;
    if (s.state === 'gen') return `${lbl}: ${s.tokenCount} tok`;
    const detail = s.detail ? ` ${s.detail}` : '';
    return `${lbl}: ${c.cyan}${s.state}${c.reset}${detail}`;
  });
  status(`    ${c.dim}\u25c6${c.reset} ${parts.join('  ')}`);
}

// ── View handlers ────────────────────────────────────────────────

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

function agentHandler(state: ViewState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'agent:spawn': {
        // If parent is a known labeled agent, this is a sub-agent
        if (state.agentLabel.has(ev.parentAgentId)) {
          state.agentParent.set(ev.agentId, ev.parentAgentId);
        }
        break;
      }
      case 'agent:produce': {
        const sub = isSubAgent(state, ev.agentId);
        state.agentText.set(ev.agentId, (state.agentText.get(ev.agentId) ?? '') + ev.text);
        state.agentStatus.set(ev.agentId, { state: 'gen', tokenCount: ev.tokenCount, detail: '' });
        if (sub) break;  // sub-agents: skip verbose/status output
        if (_verboseMode) {
          const lbl = label(state, ev.agentId);
          if (ev.tokenCount === 1) {
            statusClear();
            process.stdout.write(`\n    ${c.dim}───${c.reset} ${c.yellow}${lbl}${c.reset} ${c.dim}tokens${c.reset} ${c.dim}───${c.reset}\n    `);
          }
          process.stdout.write(ev.text);
        } else {
          renderStatus(state);
        }
        break;
      }
      case 'agent:tool_call': {
        const sub = isSubAgent(state, ev.agentId);
        if (_verboseMode && !sub) process.stdout.write('\n');
        state.agentText.delete(ev.agentId);
        state.agentStatus.set(ev.agentId, { state: ev.tool, tokenCount: 0, detail: '' });
        emit('tool_call', { agentId: ev.agentId, toolName: ev.tool, arguments: ev.args });
        let toolArgs: Record<string, string>;
        try { toolArgs = JSON.parse(ev.args); } catch { toolArgs = {}; }
        const argSummary = ev.tool === 'search'
          ? `"${toolArgs.query || ''}"`
          : ev.tool === 'grep'
          ? `/${toolArgs.pattern || ''}/`
          : ev.tool === 'report' ? ''
          : `${toolArgs.filename}` + (toolArgs.startLine ? ` L${toolArgs.startLine}-${toolArgs.endLine}` : '');
        if (sub) {
          const plbl = `${c.yellow}${parentLabel(state, ev.agentId)}${c.reset}`;
          log(`    ${c.dim}\u2502${c.reset}  ${c.dim}\u2514${c.reset} ${plbl} ${c.cyan}${ev.tool}${c.reset}${argSummary ? `(${argSummary})` : ''}`);
        } else {
          log(`    ${c.dim}\u251c${c.reset} ${c.yellow}${label(state, ev.agentId)}${c.reset} ${c.cyan}${ev.tool}${c.reset}${argSummary ? `(${argSummary})` : ''}`);
        }
        break;
      }
      case 'agent:tool_result': {
        emit('tool_result', {
          agentId: ev.agentId, toolName: ev.tool,
          result: ev.result.length > 200 ? ev.result.slice(0, 200) + '...' : ev.result,
        });
        let preview = '';
        if (ev.tool === 'read_file') {
          try {
            const firstLine = (JSON.parse(ev.result) as { content: string }).content.split('\n').find((l: string) => l.trim());
            if (firstLine) preview = ` \u00b7 ${firstLine.trim().slice(0, 60)}${firstLine.trim().length > 60 ? '\u2026' : ''}`;
          } catch { /* non-fatal */ }
        } else if (ev.tool === 'search') {
          try {
            const top = (JSON.parse(ev.result) as { heading: string }[])[0];
            if (top?.heading) preview = ` \u00b7 ${top.heading}`;
          } catch { /* non-fatal */ }
        } else if (ev.tool === 'grep') {
          try {
            const r = JSON.parse(ev.result) as { totalMatches: number; matchingLines: number };
            preview = ` \u00b7 ${r.totalMatches} matches in ${r.matchingLines} lines`;
          } catch { /* non-fatal */ }
        }
        if (isSubAgent(state, ev.agentId)) {
          const plbl = `${c.yellow}${parentLabel(state, ev.agentId)}${c.reset}`;
          log(`    ${c.dim}\u2502${c.reset}  ${c.dim}\u2514${c.reset} ${plbl} ${c.dim}\u2190 ${ev.tool} ${ev.result.length}b${preview}${c.reset}`);
        } else {
          log(`    ${c.dim}\u251c${c.reset} ${c.yellow}${label(state, ev.agentId)}${c.reset} ${c.dim}\u2190 ${ev.tool} ${ev.result.length}b${preview}${c.reset}`);
        }
        break;
      }
      case 'agent:tool_progress': {
        state.agentStatus.set(ev.agentId, { state: ev.tool, tokenCount: 0, detail: `${ev.filled}/${ev.total}` });
        renderStatus(state);
        break;
      }
      case 'agent:report': {
        state.agentStatus.set(ev.agentId, { state: 'done', tokenCount: 0, detail: '' });
        const sub = isSubAgent(state, ev.agentId);
        const cols = process.stdout.columns || 80;
        const displayLabel = sub ? parentLabel(state, ev.agentId) : label(state, ev.agentId);
        const lbl = `${c.yellow}${displayLabel}${c.reset}`;
        const indent = sub ? `    ${c.dim}\u2502${c.reset}  ` : '    ';
        const prefix = `${indent}${c.dim}\u2502${c.reset}   `;
        const wrap = cols - (sub ? 11 : 8);

        log(`${indent}${c.dim}\u2502${c.reset}`);
        log(`${indent}${c.dim}\u251c\u2500\u2500${c.reset} ${lbl} ${c.bold}findings${c.reset}`);

        for (const para of ev.findings.split('\n')) {
          if (!para.trim()) { log(prefix); continue; }
          const words = para.split(/\s+/);
          let line = '';
          for (const word of words) {
            if (line && line.length + 1 + word.length > wrap) {
              log(`${prefix}${c.dim}${line}${c.reset}`);
              line = word;
            } else {
              line = line ? `${line} ${word}` : word;
            }
          }
          if (line) log(`${prefix}${c.dim}${line}${c.reset}`);
        }
        log(`${indent}${c.dim}\u2502${c.reset}`);
        break;
      }
      case 'agent:done':
        if (_verboseMode && !isSubAgent(state, ev.agentId)) process.stdout.write('\n');
        break;
    }
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
        ev.pool.agents.forEach((a, i) => {
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

function verifyHandler(): ViewHandler {
  let pendingAgreement: AgreementResult | null = null;

  return (ev) => {
    switch (ev.type) {
      case 'verify:start': {
        log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Verify${c.reset} ${c.dim}${ev.count} attempts${c.reset}`);
        pendingAgreement = null;
        break;
      }
      case 'verify:agreement': {
        pendingAgreement = ev.result;
        emit('verify_agreement', {
          overall: ev.result.overall,
          sections: ev.result.sections.map(s => ({ label: s.label, score: s.score })),
        });
        break;
      }
      case 'verify:done': {
        ev.result.attempts.forEach((a, i) => {
          const tree = i === ev.result.attempts.length - 1
            ? (pendingAgreement ? '\u251c' : '\u2514')
            : '\u251c';
          emit('attempt_done', { index: i, output: a.output.trim().slice(0, 500), tokenCount: a.tokenCount, ppl: a.ppl });
          log(`    ${c.dim}${tree} ${a.tokenCount} tok \u00b7 ppl ${a.ppl.toFixed(2)}${c.reset}`);
        });
        if (pendingAgreement && pendingAgreement.sections.length > 0) {
          const pct = Math.round(pendingAgreement.overall * 100);
          log(`    ${c.dim}\u251c${c.reset} Agreement: ${c.bold}${pct}%${c.reset}`);
          const sorted = [...pendingAgreement.sections].sort((a, b) => b.score - a.score);
          const show = sorted.slice(0, 5);
          const maxLabelLen = Math.max(...show.map(s => s.label.length));
          show.forEach((s, i) => {
            const tree = i === show.length - 1 && sorted.length <= 5 ? '\u2514' : '\u251c';
            const filled = Math.round(s.score * 10);
            const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(10 - filled);
            const sPct = pad(Math.round(s.score * 100), 3);
            const label = `"${s.label}"`.padEnd(maxLabelLen + 2);
            log(`    ${c.dim}${tree}${c.reset} ${c.dim}${label}${c.reset} ${sPct}%  ${bar}`);
          });
          if (sorted.length > 5) {
            log(`    ${c.dim}\u2514 \u2026 ${sorted.length - 5} more${c.reset}`);
          }
        }
        log(`    ${c.dim}${ev.result.totalTokens} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
        pendingAgreement = null;
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
    log(`\n  ${c.green}\u25cf${c.reset} ${c.bold}Eval${c.reset} ${c.dim}${ev.tokenCount} tok \u00b7 ${(ev.timeMs / 1000).toFixed(1)}s${c.reset}`);
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

function statsHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'stats') return;
    const { timings, kvLine, ctxPct, ctxPos, ctxTotal } = ev;
    const totalTokens = timings.reduce((s, p) => s + p.tokens, 0);
    const totalMs = timings.reduce((s, p) => s + p.timeMs, 0);

    log(`\n  ${c.dim}${'\u2501'.repeat(58)}${c.reset}`);
    for (const p of timings) {
      const left = `${p.label.padEnd(10)} ${pad(p.tokens, 5)} tok`;
      const detail = p.detail ? `  ${p.detail}` : '';
      const right = p.timeMs > 0 ? `${pad((p.timeMs / 1000).toFixed(1), 6)}s` : '';
      log(`  ${c.dim}${left}${detail}${' '.repeat(Math.max(1, 58 - left.length - detail.length - right.length))}${right}${c.reset}`);
    }
    log(`  ${c.dim}${'\u2501'.repeat(58)}${c.reset}`);
    log(`  ${c.bold}Total${c.reset}      ${c.bold}${pad(totalTokens, 5)}${c.reset} tok         ${c.bold}${pad((totalMs / 1000).toFixed(1), 6)}s${c.reset}`);
    if (kvLine) log(`  ${c.dim}${kvLine}${c.reset}`);
    if (ctxPct != null && ctxPos != null && ctxTotal != null) {
      const ctxStr = `ctx: ${ctxPct}% (${ctxPos.toLocaleString()}/${ctxTotal.toLocaleString()})`;
      log(`  ${c.dim}${'\u2501'.repeat(58)}${c.reset}`);
      log(`  ${c.dim}${' '.repeat(58 - ctxStr.length)}${ctxStr}${c.reset}`);
    }
    log();
  };
}

function completeHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'complete') return;
    emit('complete', ev.data);
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
  const state: ViewState = {
    agentLabel: new Map(),
    nextLabel: 0,
    agentText: new Map(),
    agentStatus: new Map(),
    agentParent: new Map(),
    traceQuery: '',
  };

  const handlers: ViewHandler[] = [
    queryHandler(state, opts),
    planHandler(),
    agentHandler(state),
    researchSummaryHandler(state),
    verifyHandler(),
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
