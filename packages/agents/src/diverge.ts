import { call, ensure } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import { Ctx, Store } from './context';
import { ContextPressure } from './agent-pool';
import type { DivergeOptions, DivergeResult, DivergeAttempt } from './types';

/**
 * Multi-branch perplexity selection as an Effection operation
 *
 * Forks N branches from a parent (or a fresh root), generates to EOG via
 * batched {@link BranchStore.commit}, then selects the lowest-perplexity
 * attempt. Loser branches are pruned; the caller receives the best branch
 * still alive.
 *
 * When `opts.parent` is provided, the parent branch is NOT pruned — it's
 * owned by the calling scope. Only the forked attempt branches (losers)
 * are pruned. The caller owns the winning branch's lifecycle, typically
 * via {@link Session.promote}.
 *
 * Cleanup is structured: each forked branch registers an `ensure()` callback
 * that prunes it on scope exit. Winners are marked disposed-safe (already
 * pruned or ownership transferred) before the ensure fires.
 *
 * @param opts - Diverge options specifying parent or prompt, attempt count,
 *   and sampling parameters
 * @returns Result containing the best branch, all attempt outputs, and
 *   aggregate statistics
 *
 * @example Verify with perplexity selection
 * ```typescript
 * const verified = yield* diverge({
 *   prompt: verifyPrompt,
 *   attempts: 3,
 *   params: { temperature: 0.7 },
 * });
 * // verified.best is the lowest-perplexity branch, still alive
 * yield* call(() => session.promote(verified.best));
 * ```
 *
 * @category Agents
 */
export function* diverge(opts: DivergeOptions): Operation<DivergeResult> {
  const ctx = yield* Ctx.expect();
  const store = yield* Store.expect();

  // If parent provided, fork from it. Otherwise create a fresh root.
  let root: Branch;
  let ownRoot = false;
  let prefixLength: number;

  if (opts.parent) {
    root = opts.parent;
    prefixLength = root.position;
  } else {
    if (!opts.prompt) throw new Error('diverge() requires either opts.parent or opts.prompt');
    const tokens = ctx.tokenizeSync(opts.prompt);
    root = Branch.create(ctx, 0, opts.params ?? {});
    yield* call(() => root.prefill(tokens));
    prefixLength = tokens.length;
    ownRoot = true;
    // If we created the root, ensure it's cleaned up
    yield* ensure(() => {
      if (ownRoot && !root.disposed) {
        try { root.pruneSync(); } catch { /* children may remain */ }
      }
    });
  }

  const live: { branch: Branch; output: string; done: boolean; tokenCount: number; ppl: number }[] = [];

  for (let i = 0; i < opts.attempts; i++) {
    const branch = root.forkSync();
    // Each forked branch gets its own ensure() for structured cleanup
    yield* ensure(() => {
      if (!branch.disposed) {
        try { branch.pruneSync(); } catch { /* already gone */ }
      }
    });
    branch.reseedSampler(2000 + i);
    live.push({ branch, output: '', done: false, tokenCount: 0, ppl: Infinity });
  }

  // Batched generation — produceSync/commit loop
  let steps = 0;
  for (;;) {
    const pressure = new ContextPressure(ctx);
    if (pressure.critical) {
      for (const a of live) { if (!a.done) a.done = true; }
      break;
    }

    const entries: [Branch, number][] = [];
    for (const a of live) {
      if (a.done) continue;
      const { token, text, isStop } = a.branch.produceSync();
      if (isStop) {
        const p = a.branch.perplexity;
        a.ppl = Number.isFinite(p) ? p : Infinity;
        a.done = true;
        continue;
      }
      entries.push([a.branch, token]);
      a.output += text;
      a.tokenCount++;
    }
    if (entries.length === 0) break;
    yield* call(() => store.commit(entries));
    steps++;
  }

  // Select by lowest perplexity (most coherent)
  const bestIdx = live.reduce((bi, a, i) => a.ppl <= live[bi].ppl ? i : bi, 0);

  // Prune losers now — winner stays alive as caller's result.
  // ensure() will be a no-op for these since they're already disposed.
  for (let i = 0; i < live.length; i++) {
    if (i !== bestIdx && !live[i].branch.disposed) {
      live[i].branch.pruneSync();
    }
  }

  // If we created root and it's no longer needed, prune it now.
  // (ensure() will be a no-op since it checks disposed)
  if (ownRoot && !root.disposed && root.children.length === 0) {
    root.pruneSync();
  }

  const totalTokens = live.reduce((s, a) => s + a.tokenCount, 0);
  const attempts: DivergeAttempt[] = live.map(a => ({
    branch: a.branch,
    output: a.output,
    tokenCount: a.tokenCount,
    ppl: a.ppl,
  }));

  return {
    best: live[bestIdx].branch,
    bestOutput: live[bestIdx].output,
    attempts,
    totalTokens,
    steps,
    prefixLength,
  };
}
