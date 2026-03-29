import { describe, it, expect, vi } from 'vitest';
import { Source, NULL_SCORER } from '../src/source';
import type { EntailmentScorer, ScorerReranker } from '../src/source';
import { createMockReranker } from './helpers/mock-reranker';

// Concrete subclass for testing (Source is abstract)
class TestSource extends Source<{ reranker: ScorerReranker }> {
  readonly name = 'test';
  get tools() { return []; }

  *bind(ctx: { reranker: ScorerReranker }) {
    this._reranker = ctx.reranker;
  }

  // Expose protected field for testing
  setFloor(floor: number) { this._entailmentFloor = floor; }
}

describe('Source.createScorer', () => {
  it('returns NULL_SCORER when no reranker', () => {
    const source = new TestSource();
    const scorer = source.createScorer('some query');
    expect(scorer).toBe(NULL_SCORER);
  });

  it('returns NULL_SCORER when empty originalQuery', () => {
    const source = new TestSource();
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('');
    expect(scorer).toBe(NULL_SCORER);
  });

  it('returns functional scorer when both reranker and query present', async () => {
    const scores = new Map([['relevant text', 0.8], ['irrelevant text', 0.1]]);
    const reranker = createMockReranker(scores);
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('original query');
    const results = await scorer.scoreEntailmentBatch(['relevant text', 'irrelevant text']);

    expect(results).toEqual([0.8, 0.1]);
  });

  it('delegates to reranker.scoreBatch with originalQuery', async () => {
    const scoreBatch = vi.fn(async (_q: string, texts: string[]) => texts.map(() => 0.5));
    const source = new TestSource();
    (source as any)._reranker = { scoreBatch } as any;

    const scorer = source.createScorer('my original query');
    await scorer.scoreEntailmentBatch(['text1', 'text2']);

    expect(scoreBatch).toHaveBeenCalledWith('my original query', ['text1', 'text2']);
  });

  it('scorer is immutable after creation', async () => {
    const reranker1 = createMockReranker(new Map([['t', 0.9]]));
    const source = new TestSource();
    (source as any)._reranker = reranker1;

    const scorer = source.createScorer('q');

    // Change the reranker on source — scorer should still use the original
    const reranker2 = createMockReranker(new Map([['t', 0.1]]));
    (source as any)._reranker = reranker2;

    const result = await scorer.scoreEntailmentBatch(['t']);
    expect(result[0]).toBe(0.9); // uses original reranker, not the new one
  });

  it('multiple scorers from same source are independent', async () => {
    const reranker = createMockReranker();
    const scoreBatch = vi.fn(async (q: string, _texts: string[]) => [q === 'query-A' ? 0.9 : 0.1]);
    (reranker as any).scoreBatch = scoreBatch;

    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorerA = source.createScorer('query-A');
    const scorerB = source.createScorer('query-B');

    const resultA = await scorerA.scoreEntailmentBatch(['t']);
    const resultB = await scorerB.scoreEntailmentBatch(['t']);

    expect(resultA[0]).toBe(0.9);
    expect(resultB[0]).toBe(0.1);
  });
});

describe('shouldProceed', () => {
  it('returns true at default floor (0.25)', async () => {
    const source = new TestSource();
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('q');

    expect(scorer.shouldProceed(0.25)).toBe(true);
    expect(scorer.shouldProceed(0.26)).toBe(true);
    expect(scorer.shouldProceed(0.24)).toBe(false);
  });

  it('respects custom floor', async () => {
    const source = new TestSource();
    source.setFloor(0.5);
    (source as any)._reranker = createMockReranker();
    const scorer = source.createScorer('q');

    expect(scorer.shouldProceed(0.5)).toBe(true);
    expect(scorer.shouldProceed(0.49)).toBe(false);
  });
});

describe('NULL_SCORER', () => {
  it('returns 1.0 for all texts', async () => {
    const results = await NULL_SCORER.scoreEntailmentBatch(['a', 'b', 'c']);
    expect(results).toEqual([1, 1, 1]);
  });

  it('always proceeds', () => {
    expect(NULL_SCORER.shouldProceed(0)).toBe(true);
    expect(NULL_SCORER.shouldProceed(-1)).toBe(true);
  });

  it('scoreSimilarityBatch returns 0 (guard never fires)', async () => {
    const results = await NULL_SCORER.scoreSimilarityBatch('any ref', ['a', 'b']);
    expect(results).toEqual([0, 0]);
  });
});

describe('scoreSimilarityBatch', () => {
  it('scores texts against an arbitrary reference', async () => {
    const scores = new Map([
      ['speculative decoding on M3 Max', 0.92],
      ['unified memory architecture for inference', 0.35],
    ]);
    const reranker = createMockReranker(scores);
    const source = new TestSource();
    (source as any)._reranker = reranker;

    const scorer = source.createScorer('original query');
    const results = await scorer.scoreSimilarityBatch(
      'speculative decoding benchmarks on Apple Silicon',
      ['speculative decoding on M3 Max', 'unified memory architecture for inference'],
    );

    expect(results[0]).toBe(0.92);
    expect(results[1]).toBe(0.35);
  });

  it('uses the reference argument, not originalQuery', async () => {
    const scoreBatch = vi.fn(async (q: string, _texts: string[]) =>
      [q === 'custom ref' ? 0.99 : 0.01],
    );
    const source = new TestSource();
    (source as any)._reranker = { scoreBatch };

    const scorer = source.createScorer('original query');
    const result = await scorer.scoreSimilarityBatch('custom ref', ['t']);

    expect(scoreBatch).toHaveBeenCalledWith('custom ref', ['t']);
    expect(result[0]).toBe(0.99);
  });
});
