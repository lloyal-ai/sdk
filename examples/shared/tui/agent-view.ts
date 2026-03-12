import type { ViewState, ViewHandler } from './types';
import type { GaugeState } from './gauge';
import { c, log, status, statusClear, emit, isVerboseMode } from './primitives';

export function createViewState(): ViewState {
  return {
    agentLabel: new Map(),
    nextLabel: 0,
    agentText: new Map(),
    agentStatus: new Map(),
    agentParent: new Map(),
    rootToAgent: new Map(),
    spawningQueue: [],
    traceQuery: '',
  };
}

export function label(state: ViewState, agentId: number): string {
  let l = state.agentLabel.get(agentId);
  if (!l) { l = `A${state.nextLabel++}`; state.agentLabel.set(agentId, l); }
  return l;
}

export function resetLabels(state: ViewState): void {
  state.nextLabel = 0;
  state.agentLabel.clear();
  state.agentStatus.clear();
  state.agentText.clear();
  state.agentParent.clear();
  state.rootToAgent.clear();
  state.spawningQueue.length = 0;
}

export function isSubAgent(state: ViewState, agentId: number): boolean {
  return state.agentParent.has(agentId);
}

export function parentLabel(state: ViewState, agentId: number): string {
  return label(state, state.agentParent.get(agentId)!);
}

export function renderStatus(state: ViewState, suffix?: string): void {
  const active = [...state.agentStatus.entries()]
    .filter(([id, s]) => s.state !== 'done' && !isSubAgent(state, id));
  if (active.length === 0) return;

  const sfx = suffix || '';

  const generating = active.filter(([, s]) => s.state === 'gen');
  if (generating.length === 1 && active.length === 1) {
    const [id] = generating[0];
    const raw = (state.agentText.get(id) ?? '').replace(/\n/g, ' ').trimStart();
    const cols = process.stdout.columns || 80;
    const maxLen = cols - 12 - (sfx ? sfx.length + 2 : 0);
    const text = raw.length > maxLen ? raw.slice(raw.length - maxLen) : raw;
    status(`    ${c.dim}\u25c6${c.reset} ${c.yellow}${label(state, id)}${c.reset} ${text}${sfx}`);
    return;
  }

  const parts = active.map(([id, s]) => {
    const lbl = `${c.yellow}${label(state, id)}${c.reset}`;
    if (s.state === 'gen') return `${lbl}: ${s.tokenCount} tok`;
    const detail = s.detail ? ` ${s.detail}` : '';
    return `${lbl}: ${c.cyan}${s.state}${c.reset}${detail}`;
  });
  status(`    ${c.dim}\u25c6${c.reset} ${parts.join('  ')}${sfx}`);
}

function pressureSuffix(gauge?: GaugeState): string {
  if (!gauge || gauge.nCtx <= 0) return '';
  const pct = Math.min(100, Math.round((gauge.cellsUsed / gauge.nCtx) * 100));
  const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  return `  ${color}${pct}%${c.reset}`;
}

export function agentHandler(state: ViewState, gauge?: GaugeState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'agent:spawn': {
        if (state.agentLabel.has(ev.parentAgentId)) {
          state.agentParent.set(ev.agentId, ev.parentAgentId);
        } else {
          // Unknown parent = root branch from withSharedRoot inside a tool
          let logicalParent = state.rootToAgent.get(ev.parentAgentId);
          if (logicalParent == null && state.spawningQueue.length > 0) {
            logicalParent = state.spawningQueue[0];
            state.rootToAgent.set(ev.parentAgentId, logicalParent);
          }
          if (logicalParent != null) {
            state.agentParent.set(ev.agentId, logicalParent);
          }
        }
        break;
      }
      case 'agent:produce': {
        const sub = isSubAgent(state, ev.agentId);
        state.agentText.set(ev.agentId, (state.agentText.get(ev.agentId) ?? '') + ev.text);
        state.agentStatus.set(ev.agentId, { state: 'gen', tokenCount: ev.tokenCount, detail: '' });
        if (sub) break;  // sub-agents: skip verbose/status output
        if (!isVerboseMode()) renderStatus(state, pressureSuffix(gauge));
        // verbose: accumulate only — flushed as a block on tool_call/done
        break;
      }
      case 'agent:tool_call': {
        if (ev.tool === 'web_research' || ev.tool === 'research') {
          state.spawningQueue.push(ev.agentId);
        }
        const sub = isSubAgent(state, ev.agentId);
        if (isVerboseMode() && !sub) {
          const raw = (state.agentText.get(ev.agentId) ?? '').trim();
          if (raw) {
            statusClear();
            const lbl = label(state, ev.agentId);
            log(`    ${c.dim}\u2500\u2500\u2500 ${c.yellow}${lbl}${c.reset} ${c.dim}tokens \u2500\u2500\u2500${c.reset}`);
            for (const line of raw.split('\n')) {
              log(`    ${c.dim}${line}${c.reset}`);
            }
          }
        }
        state.agentText.delete(ev.agentId);
        state.agentStatus.set(ev.agentId, { state: ev.tool, tokenCount: 0, detail: '' });
        emit('tool_call', { agentId: ev.agentId, toolName: ev.tool, arguments: ev.args });
        let toolArgs: Record<string, string>;
        try { toolArgs = JSON.parse(ev.args); } catch { toolArgs = {}; }
        const argSummary = ev.tool === 'search' || ev.tool === 'web_search'
          ? `"${toolArgs.query || ''}"`
          : ev.tool === 'grep'
          ? `/${toolArgs.pattern || ''}/`
          : ev.tool === 'report' ? ''
          : ev.tool === 'research' || ev.tool === 'web_research'
          ? `${(toolArgs.questions as string[] | undefined)?.length ?? 0} questions`
          : ev.tool === 'plan'
          ? `"${toolArgs.query || ''}"`
          : ev.tool === 'fetch_page'
          ? `${toolArgs.url || ''}`
          : `${toolArgs.filename}` + (toolArgs.startLine ? ` L${toolArgs.startLine}-${toolArgs.endLine}` : '');
        if (sub) {
          const plbl = `${c.yellow}${parentLabel(state, ev.agentId)}${c.reset}`;
          log(`    ${c.dim}\u2502${c.reset}  ${c.dim}\u2514${c.reset} ${plbl} ${c.cyan}${ev.tool}${c.reset}${argSummary ? `(${argSummary})` : ''}`);
        } else {
          log(`    ${c.dim}\u251c${c.reset} ${c.yellow}${label(state, ev.agentId)}${c.reset} ${c.cyan}${ev.tool}${c.reset}${argSummary ? `(${argSummary})` : ''}`);
        }
        if (ev.tool === 'research' || ev.tool === 'web_research') {
          const qs = (toolArgs as Record<string, unknown>).questions as string[] | undefined;
          const indent = sub ? `    ${c.dim}\u2502${c.reset}  ` : '    ';
          qs?.forEach((q, i) => {
            log(`${indent}${c.dim}\u2502${c.reset}   ${c.dim}${i + 1}. ${q}${c.reset}`);
          });
        }
        break;
      }
      case 'agent:tool_result': {
        if (ev.tool === 'web_research' || ev.tool === 'research') {
          const idx = state.spawningQueue.indexOf(ev.agentId);
          if (idx >= 0) state.spawningQueue.splice(idx, 1);
        }
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
        } else if (ev.tool === 'web_search') {
          try {
            const results = JSON.parse(ev.result) as { title: string }[];
            if (results.length) preview = ` \u00b7 ${results.length} results \u00b7 ${results[0].title}`;
          } catch { /* non-fatal */ }
        } else if (ev.tool === 'fetch_page') {
          try {
            const r = JSON.parse(ev.result) as { title?: string; error?: string };
            if (r.error) preview = ` \u00b7 ${r.error}`;
            else if (r.title) preview = ` \u00b7 ${r.title.slice(0, 60)}${r.title.length > 60 ? '\u2026' : ''}`;
          } catch { /* non-fatal */ }
        } else if (ev.tool === 'plan') {
          try {
            const r = JSON.parse(ev.result) as { intent: string; questions: string[] };
            preview = ` \u00b7 ${r.intent}${r.questions?.length ? ` \u00b7 ${r.questions.length} questions` : ''}`;
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
        renderStatus(state, pressureSuffix(gauge));
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
      case 'agent:done': {
        if (isVerboseMode() && !isSubAgent(state, ev.agentId)) {
          const raw = (state.agentText.get(ev.agentId) ?? '').trim();
          if (raw) {
            statusClear();
            const lbl = label(state, ev.agentId);
            log(`    ${c.dim}\u2500\u2500\u2500 ${c.yellow}${lbl}${c.reset} ${c.dim}tokens \u2500\u2500\u2500${c.reset}`);
            for (const line of raw.split('\n')) {
              log(`    ${c.dim}${line}${c.reset}`);
            }
          }
        }
        break;
      }
      case 'agent:tick': {
        // Re-render status line with updated pressure
        if (!isVerboseMode()) renderStatus(state, pressureSuffix(gauge));
        break;
      }
    }
  };
}
