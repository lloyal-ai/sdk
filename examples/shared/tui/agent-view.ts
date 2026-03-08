import type { ViewState, ViewHandler } from './types';
import { c, log, status, statusClear, emit, isVerboseMode } from './primitives';

export function createViewState(): ViewState {
  return {
    agentLabel: new Map(),
    nextLabel: 0,
    agentText: new Map(),
    agentStatus: new Map(),
    agentParent: new Map(),
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
}

export function isSubAgent(state: ViewState, agentId: number): boolean {
  return state.agentParent.has(agentId);
}

export function parentLabel(state: ViewState, agentId: number): string {
  return label(state, state.agentParent.get(agentId)!);
}

export function renderStatus(state: ViewState): void {
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

export function agentHandler(state: ViewState): ViewHandler {
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
        if (isVerboseMode()) {
          const lbl = label(state, ev.agentId);
          if (ev.tokenCount === 1) {
            statusClear();
            process.stdout.write(`\n    ${c.dim}\u2500\u2500\u2500${c.reset} ${c.yellow}${lbl}${c.reset} ${c.dim}tokens${c.reset} ${c.dim}\u2500\u2500\u2500${c.reset}\n    `);
          }
          process.stdout.write(ev.text);
        } else {
          renderStatus(state);
        }
        break;
      }
      case 'agent:tool_call': {
        const sub = isSubAgent(state, ev.agentId);
        if (isVerboseMode() && !sub) process.stdout.write('\n');
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
        if (isVerboseMode() && !isSubAgent(state, ev.agentId)) process.stdout.write('\n');
        break;
    }
  };
}
