/**
 * Tests for {@link Rerank.score} AsyncIterator cancellation semantics.
 *
 * These tests lock the contract that `for await ... break`, explicit
 * `iterator.return()`, and concurrent-iterator cancellation all stop the
 * upstream `_scoreGroup` drain in bounded time. Pre-SDK-2.2.0, the channel
 * helper inside Rerank.ts had no `return()` and the drain had no per-request
 * cancellation flag — so a cancelled consumer left the drain pumping
 * native dispatches until every queued document was scored.
 *
 * The three cancellation tests are marked `it.fails` against the pre-fix
 * Rerank.ts and flip to `it` once the 4-edit fix lands (see
 * docs-tmp/hdk-app-contract.md §5.8 / plan Phase 2).
 *
 * @category Testing
 */

import { describe, it, expect } from 'vitest';
import { Rerank } from '../src/Rerank';
import { MockSessionContext } from './MockSessionContext';

// ── Test fixture ─────────────────────────────────────────────────

/**
 * `MockSessionContext` extension that supports Rerank scoring:
 *
 * - Returns distinct token IDs for `'yes'` and `'no'` so `yesId` / `noId`
 *   are different (the base mock collapses both to `[1]`, which would make
 *   {@link Rerank._rerankScore} divide by zero or return a constant 0.5).
 * - Records every `_scoreGroup` invocation so tests can assert the drain
 *   stopped at a specific call count.
 * - Optionally delays each `_scoreGroup` call so the test can pull a
 *   progress event, cancel, and check that subsequent calls didn't fire.
 * - Returns synthetic logits where the `yes` token dominates → scores
 *   are non-trivially ordered (close to 1).
 */
class TestRerankCtx extends MockSessionContext {
  readonly YES_TOKEN = 100;
  readonly NO_TOKEN = 101;

  /** Records each `_scoreGroup` invocation's input. */
  scoreGroupCalls: number[][][] = [];

  /** Per-call delay in ms. Set >0 to enable cancellation interleave windows. */
  scoreGroupDelayMs = 0;

  override async tokenize(text: string, addSpecial?: boolean): Promise<number[]> {
    if (text === 'yes') return [this.YES_TOKEN];
    if (text === 'no') return [this.NO_TOKEN];
    return super.tokenize(text, addSpecial);
  }

  override tokenizeSync(text: string, addSpecial?: boolean): number[] {
    if (text === 'yes') return [this.YES_TOKEN];
    if (text === 'no') return [this.NO_TOKEN];
    return super.tokenizeSync(text, addSpecial);
  }

  override async _scoreGroup(tokenArrays: number[][]): Promise<Float32Array[]> {
    // Snapshot the input so the test can inspect call shape even if the
    // caller mutates the arrays afterward.
    this.scoreGroupCalls.push(tokenArrays.map((arr) => [...arr]));
    if (this.scoreGroupDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.scoreGroupDelayMs));
    }
    // Synthetic logits: yes dominates → score ≈ 1 for every document.
    // We don't need varied scores for cancellation tests; we only need
    // `_scoreGroup` to be invoked the expected number of times.
    return tokenArrays.map(() => {
      const logits = new Float32Array(this.vocabSize);
      logits[this.YES_TOKEN] = 10;
      logits[this.NO_TOKEN] = 0;
      return logits;
    });
  }
}

async function createTestRerank(opts?: { nCtx?: number; nSeqMax?: number }) {
  const nCtx = opts?.nCtx ?? 4096;
  const nSeqMax = opts?.nSeqMax ?? 4;
  const ctx = new TestRerankCtx({ nCtx });
  const rerank = await Rerank.create(ctx, { nSeqMax, nCtx });
  // Reset call recording after Rerank.create (which makes its own tokenize
  // calls but not _scoreGroup calls — defensive).
  ctx.scoreGroupCalls = [];
  return { ctx, rerank };
}

// Tokens-per-doc must be small enough that ctx-budget math works out:
//   maxDoc = floor(nCtx / nSeqMax) - shared.length - suffix.length
// With nCtx=4096, nSeqMax=2, shared ~ 5-10 tokens, suffix ~ 5 tokens,
// maxDoc ≈ 2030 — comfortably above our 2-token-per-doc fixtures.
const mkDocs = (n: number): number[][] =>
  Array.from({ length: n }, (_, i) => [i * 10 + 1, i * 10 + 2]);

// ── Happy path ──────────────────────────────────────────────────

describe('Rerank.score happy path', () => {
  it('scores all documents and yields a final result with the full count', async () => {
    const { rerank } = await createTestRerank({ nSeqMax: 2 });
    const docs = mkDocs(4);

    const progresses: { filled: number; total: number; resultsLen: number }[] = [];
    for await (const p of rerank.score('test query', docs)) {
      progresses.push({ filled: p.filled, total: p.total, resultsLen: p.results.length });
    }

    expect(progresses.length).toBeGreaterThan(0);
    const last = progresses[progresses.length - 1];
    expect(last.filled).toBe(4);
    expect(last.total).toBe(4);
    expect(last.resultsLen).toBe(4);
  });

  it('emits progress with monotonically growing filled count', async () => {
    const { rerank } = await createTestRerank({ nSeqMax: 2 });
    const docs = mkDocs(6);

    let lastFilled = 0;
    for await (const p of rerank.score('test query', docs)) {
      expect(p.filled).toBeGreaterThan(lastFilled);
      expect(p.total).toBe(6);
      lastFilled = p.filled;
    }
    expect(lastFilled).toBe(6);
  });

  it('respects topK by truncating results', async () => {
    const { rerank } = await createTestRerank({ nSeqMax: 2 });
    const docs = mkDocs(8);

    let lastResultsLen = 0;
    for await (const p of rerank.score('test query', docs, 3)) {
      lastResultsLen = p.results.length;
    }
    expect(lastResultsLen).toBe(3);
  });

  it('invokes _scoreGroup the expected number of times for nSeqMax=2 over 4 docs', async () => {
    const { ctx, rerank } = await createTestRerank({ nSeqMax: 2 });
    const docs = mkDocs(4);

    // Consume the iterable fully.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _p of rerank.score('test query', docs)) {
      // drain
    }

    // 4 docs / nSeqMax=2 → exactly 2 dispatches.
    expect(ctx.scoreGroupCalls.length).toBe(2);
    // Each dispatch carries exactly nSeqMax token arrays.
    expect(ctx.scoreGroupCalls[0].length).toBe(2);
    expect(ctx.scoreGroupCalls[1].length).toBe(2);
  });
});

// ── Cancellation contract ───────────────────────────────────────
//
// These three tests are marked `it.fails` against the pre-2.2.0 Rerank.ts.
// Each describes the post-fix contract:
//   1. `for await ... break` causes the drain to stop within at most one
//      additional in-flight dispatch (the one already awaiting `_scoreGroup`).
//   2. Explicit `iterator.return()` has the same effect.
//   3. Cancelling one in-flight `score()` does not affect a concurrent one.
//
// The exact bound is "≤ callsAtCancel + 1" because a single `_scoreGroup`
// dispatch is in flight when cancellation fires, and we cannot abort it
// mid-call (no AbortController on the native scoring path). After that one
// completes, the next `_drain` iteration's cancellation sweep removes the
// request and the drain stops issuing dispatches for its tokens.

describe('Rerank.score cancellation', () => {
  it(
    '`for await ... break` stops upstream _scoreGroup calls within one extra dispatch',
    async () => {
      const { ctx, rerank } = await createTestRerank({ nSeqMax: 2 });
      // Many documents → ~10 drain rounds — enough headroom that pre-fix
      // behavior (keep going to the end) diverges sharply from post-fix
      // (stop within one dispatch of break).
      const docs = mkDocs(20);
      ctx.scoreGroupDelayMs = 10; // window for break to take effect

      let progressCount = 0;
      for await (const _p of rerank.score('test query', docs)) {
        progressCount++;
        if (progressCount >= 1) break;
      }

      const callsAtBreak = ctx.scoreGroupCalls.length;

      // Give the drain a chance to keep dispatching if it would.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const callsAfterDelay = ctx.scoreGroupCalls.length;

      // Post-fix: drain stopped on break.
      // Pre-fix: drain kept going; callsAfterDelay > callsAtBreak + 1.
      expect(callsAfterDelay).toBeLessThanOrEqual(callsAtBreak + 1);
    },
  );

  it(
    '`AsyncIterator.return()` stops upstream _scoreGroup calls within one extra dispatch',
    async () => {
      const { ctx, rerank } = await createTestRerank({ nSeqMax: 2 });
      const docs = mkDocs(20);
      ctx.scoreGroupDelayMs = 10;

      const iter = rerank.score('test query', docs)[Symbol.asyncIterator]();

      // Pull one progress event so the drain is well underway.
      await iter.next();
      const callsAtReturn = ctx.scoreGroupCalls.length;

      // Pre-fix: iter.return is undefined; this is a no-op.
      // Post-fix: iter.return cancels the underlying ScoringRequest.
      if (typeof iter.return === 'function') {
        await iter.return();
      }

      await new Promise((resolve) => setTimeout(resolve, 200));

      const callsAfterDelay = ctx.scoreGroupCalls.length;
      expect(callsAfterDelay).toBeLessThanOrEqual(callsAtReturn + 1);
    },
  );

  it(
    'cancelling one concurrent score() stops its dispatches but lets the co-running one complete',
    async () => {
      const { ctx, rerank } = await createTestRerank({ nSeqMax: 2 });
      // 20 + 20 docs = 40 total tokens; at nSeqMax=2 the drain interleaves
      // and issues 20 mixed dispatches if nothing is cancelled. After
      // cancelling iter1 a few dispatches in, iter2 alone needs ~10 solo
      // dispatches to finish — so post-fix total ≈ 11, pre-fix total = 20.
      const docs1 = mkDocs(20);
      const docs2 = mkDocs(20).map(([a, b]) => [a + 10_000, b + 10_000]);
      ctx.scoreGroupDelayMs = 5;

      const iter1 = rerank.score('query one', docs1)[Symbol.asyncIterator]();
      const iter2 = rerank.score('query two', docs2)[Symbol.asyncIterator]();

      // Pull one event from each so both drains are well underway.
      await iter1.next();
      await iter2.next();

      // Cancel iter1. Pre-fix: iter1.return is undefined → no-op → iter1
      // keeps draining alongside iter2 → 20 total dispatches.
      // Post-fix: iter1.return cancels its ScoringRequest → iter1's
      // dispatches stop → ~11 total dispatches.
      if (typeof iter1.return === 'function') {
        await iter1.return();
      }

      // iter2 must complete normally — full 20 docs scored, drain finishes.
      let iter2Final: { filled: number; total: number } | null = null;
      for (;;) {
        const r = await iter2.next();
        if (r.done) break;
        iter2Final = { filled: r.value.filled, total: r.value.total };
      }

      expect(iter2Final).not.toBeNull();
      expect(iter2Final!.filled).toBe(20);
      expect(iter2Final!.total).toBe(20);

      // The load-bearing assertion: total dispatches < 20 means iter1's
      // drain was actually stopped (pre-fix it would equal 20 because
      // iter1.return is a no-op).
      const totalCalls = ctx.scoreGroupCalls.length;
      expect(totalCalls).toBeGreaterThanOrEqual(10); // iter2 needs ≥10
      expect(totalCalls).toBeLessThan(20);            // iter1 was cancelled

      // No further dispatches after iter2 fully drains.
      const callsAtEnd = ctx.scoreGroupCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(ctx.scoreGroupCalls.length).toBe(callsAtEnd);
    },
  );
});
