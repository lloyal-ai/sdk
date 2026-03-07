import type { ViewHandler } from './types';
import { c, log, emit, pad } from './primitives';

export function statsHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'stats') return;
    const { timings, kvLine, ctxPct, ctxPos, ctxTotal } = ev;
    const totalTokens = timings.reduce((s: number, p: { tokens: number }) => s + p.tokens, 0);
    const totalMs = timings.reduce((s: number, p: { timeMs: number }) => s + p.timeMs, 0);

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

export function completeHandler(): ViewHandler {
  return (ev) => {
    if (ev.type !== 'complete') return;
    emit('complete', ev.data);
  };
}
