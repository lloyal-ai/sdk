import type { ViewState, ViewHandler } from './types';
import type { GaugeState } from './gauge';
import { c, log, status, statusClear, emit, isVerboseMode } from './primitives';
import { createPageStream } from './page-stream';
import { tree } from './tree';

// ── State lifecycle ────────────────────────────────────────────

export function createViewState(): ViewState {
  return {
    agentLabel: new Map(),
    nextLabel: 0,
    agentText: new Map(),
    agentStatus: new Map(),
    traceQuery: '',
    synthStream: createPageStream('  '),
    agentStream: createPageStream(`    ${tree.trunk}   `),
    synthStreamed: false,
  };
}

export function label(state: ViewState, agentId: number): string {
  let l = state.agentLabel.get(agentId);
  if (!l) {
    l = `A${state.nextLabel++}`;
    state.agentLabel.set(agentId, l);
  }
  return l;
}

export function resetLabels(state: ViewState): void {
  state.nextLabel = 0;
  state.agentLabel.clear();
  state.agentStatus.clear();
  state.agentText.clear();
}

// ── Indent / status rendering ──────────────────────────────────

const INDENT = '    ';

export function renderStatus(state: ViewState, suffix?: string): void {
  const active = [...state.agentStatus.entries()].filter(([, s]) => s.state !== 'done');
  if (active.length === 0) return;

  const sfx = suffix || '';

  // Single generating agent: render the ticker with its most recent text
  const generating = active.filter(([, s]) => s.state === 'gen');
  if (generating.length === 1 && active.length === 1) {
    const [id] = generating[0];
    const raw = (state.agentText.get(id) ?? '').replace(/\n/g, ' ').trimStart();
    const cols = process.stdout.columns || 80;
    const maxLen = cols - 12 - (sfx ? sfx.length + 2 : 0);
    const text = raw.length > maxLen ? raw.slice(raw.length - maxLen) : raw;
    status(`${INDENT}${c.dim}\u25c6${c.reset} ${c.yellow}${label(state, id)}${c.reset} ${text}${sfx}`);
    return;
  }

  // Multiple agents: terse per-agent summary
  const parts = active.map(([id, s]) => {
    const lbl = `${c.yellow}${label(state, id)}${c.reset}`;
    if (s.state === 'gen') return `${lbl}: ${s.tokenCount} tok`;
    const detail = s.detail ? ` ${s.detail}` : '';
    return `${lbl}: ${c.cyan}${s.state}${c.reset}${detail}`;
  });
  status(`${INDENT}${c.dim}\u25c6${c.reset} ${parts.join('  ')}${sfx}`);
}

function pressureSuffix(gauge?: GaugeState): string {
  if (!gauge || gauge.nCtx <= 0) return '';
  const pct = Math.min(100, Math.round((gauge.cellsUsed / gauge.nCtx) * 100));
  const color = pct >= 90 ? c.red : pct >= 70 ? c.yellow : c.green;
  return `  ${color}${pct}%${c.reset}`;
}

// ── Tool dispatch formatting ───────────────────────────────────

/**
 * Render a human-readable arg summary for a tool call. One-liners per tool
 * that parse the JSON args and extract the most salient identifier.
 */
const argSummaries: Record<string, (args: Record<string, unknown>) => string> = {
  search: (a) => `"${a.query ?? ''}"`,
  web_search: (a) => `"${a.query ?? ''}"`,
  grep: (a) => `/${a.pattern ?? ''}/`,
  report: () => '',
  plan: (a) => `"${a.query ?? ''}"`,
  fetch_page: (a) => `${a.url ?? ''}`,
};

function formatArgSummary(tool: string, rawArgs: string): string {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(rawArgs); } catch { parsed = {}; }
  const fn = argSummaries[tool];
  if (fn) return fn(parsed);
  // Fallback: file-reading tool with filename + optional line range
  const filename = parsed.filename as string | undefined;
  const startLine = parsed.startLine as number | undefined;
  const endLine = parsed.endLine as number | undefined;
  return filename ? `${filename}${startLine ? ` L${startLine}-${endLine}` : ''}` : '';
}

/**
 * Render a one-liner preview of a tool result for the tree dispatch line.
 * Each entry parses the tool's JSON response and extracts the most salient
 * field. All parsing errors silently yield an empty preview — the dispatch
 * line is a hint, not a load-bearing view.
 */
const resultPreviews: Record<string, (raw: string) => string> = {
  read_file: (raw) => {
    const firstLine = (JSON.parse(raw) as { content: string }).content.split('\n').find((l) => l.trim());
    if (!firstLine) return '';
    const trimmed = firstLine.trim();
    return ` \u00b7 ${trimmed.slice(0, 60)}${trimmed.length > 60 ? '\u2026' : ''}`;
  },
  search: (raw) => {
    const top = (JSON.parse(raw) as { heading: string }[])[0];
    return top?.heading ? ` \u00b7 ${top.heading}` : '';
  },
  grep: (raw) => {
    const r = JSON.parse(raw) as { totalMatches: number; matchingLines: number };
    return ` \u00b7 ${r.totalMatches} matches in ${r.matchingLines} lines`;
  },
  web_search: (raw) => {
    const results = JSON.parse(raw) as { title: string }[];
    return results.length ? ` \u00b7 ${results.length} results \u00b7 ${results[0].title}` : '';
  },
  fetch_page: (raw) => {
    const r = JSON.parse(raw) as { title?: string; error?: string };
    if (r.error) return ` \u00b7 ${r.error}`;
    if (r.title) return ` \u00b7 ${r.title.slice(0, 60)}${r.title.length > 60 ? '\u2026' : ''}`;
    return '';
  },
  plan: (raw) => {
    const r = JSON.parse(raw) as { intent: string; questions?: string[] };
    return ` \u00b7 ${r.intent}${r.questions?.length ? ` \u00b7 ${r.questions.length} questions` : ''}`;
  },
};

function formatResultPreview(tool: string, raw: string): string {
  const fn = resultPreviews[tool];
  if (!fn) return '';
  try { return fn(raw); } catch { return ''; }
}

// ── Main event handler ─────────────────────────────────────────

export function agentHandler(state: ViewState, gauge?: GaugeState): ViewHandler {
  return (ev) => {
    switch (ev.type) {
      case 'agent:produce': {
        // Synth phase owns stdout directly — skip entirely when synth is streaming
        if (state.synthStream.isOpen) break;
        state.agentStatus.set(ev.agentId, { state: 'gen', tokenCount: ev.tokenCount, detail: '' });
        if (isVerboseMode()) {
          // Verbose: accumulate text; flushed as a block on tool_call/done
          state.agentText.set(ev.agentId, (state.agentText.get(ev.agentId) ?? '') + ev.text);
          break;
        }
        // Default: stream generation live as a vertical page
        state.agentStream.open();
        state.agentStream.append(ev.text);
        break;
      }

      case 'agent:tool_call': {
        // Close the streamed generation segment so the tree line prints cleanly
        state.agentStream.close();
        const lbl = label(state, ev.agentId);

        if (isVerboseMode()) {
          const raw = (state.agentText.get(ev.agentId) ?? '').trim();
          if (raw) {
            statusClear();
            log(`${INDENT}${c.dim}\u2500\u2500\u2500 ${c.yellow}${lbl}${c.reset} ${c.dim}tokens \u2500\u2500\u2500${c.reset}`);
            for (const line of raw.split('\n')) log(`${INDENT}${c.dim}${line}${c.reset}`);
          }
          state.agentText.delete(ev.agentId);
        }

        state.agentStatus.set(ev.agentId, { state: ev.tool, tokenCount: 0, detail: '' });
        emit('tool_call', { agentId: ev.agentId, toolName: ev.tool, arguments: ev.args });

        const summary = formatArgSummary(ev.tool, ev.args);
        log(`${INDENT}${tree.branch} ${c.yellow}${lbl}${c.reset} ${c.cyan}${ev.tool}${c.reset}${summary ? `(${summary})` : ''}`);
        break;
      }

      case 'agent:tool_result': {
        emit('tool_result', {
          agentId: ev.agentId, toolName: ev.tool,
          result: ev.result.length > 200 ? ev.result.slice(0, 200) + '...' : ev.result,
        });
        const preview = formatResultPreview(ev.tool, ev.result);
        log(`${INDENT}${tree.branch} ${c.yellow}${label(state, ev.agentId)}${c.reset} ${c.dim}${tree.arrow} ${ev.tool} ${ev.result.length}b${preview}${c.reset}`);
        break;
      }

      case 'agent:tool_progress': {
        state.agentStatus.set(ev.agentId, { state: ev.tool, tokenCount: 0, detail: `${ev.filled}/${ev.total}` });
        if (state.synthStream.isOpen || state.agentStream.isOpen) break;
        renderStatus(state, pressureSuffix(gauge));
        break;
      }

      case 'agent:report': {
        const streamed = state.agentStream.hadContent;
        state.agentStream.close();
        state.agentStatus.set(ev.agentId, { state: 'done', tokenCount: 0, detail: '' });

        // If the report text already streamed live, skip the post-hoc block dump.
        // Fallback: recovery extraction produces a report without streaming —
        // render the word-wrapped block so the text still appears.
        if (streamed) break;

        const cols = process.stdout.columns || 80;
        const lbl = `${c.yellow}${label(state, ev.agentId)}${c.reset}`;
        const prefix = `${INDENT}${tree.trunk}   `;
        const wrap = cols - 8;

        log(`${INDENT}${tree.trunk}`);
        log(`${INDENT}${tree.stem} ${lbl} ${c.bold}findings${c.reset}`);

        for (const para of ev.result.split('\n')) {
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
        log(`${INDENT}${tree.trunk}`);
        break;
      }

      case 'agent:done': {
        if (!isVerboseMode()) break;
        const raw = (state.agentText.get(ev.agentId) ?? '').trim();
        if (!raw) break;
        statusClear();
        const lbl = label(state, ev.agentId);
        log(`${INDENT}${c.dim}\u2500\u2500\u2500 ${c.yellow}${lbl}${c.reset} ${c.dim}tokens \u2500\u2500\u2500${c.reset}`);
        for (const line of raw.split('\n')) log(`${INDENT}${c.dim}${line}${c.reset}`);
        break;
      }

      case 'agent:tick': {
        if (state.synthStream.isOpen || state.agentStream.isOpen) break;
        if (!isVerboseMode()) renderStatus(state, pressureSuffix(gauge));
        break;
      }
    }
  };
}

