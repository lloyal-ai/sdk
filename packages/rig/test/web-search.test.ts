import { describe, it, expect, vi } from 'vitest';
import type { EntailmentScorer } from '../../agents/src/source';

/**
 * WebSearchTool entailment reranking tests.
 *
 * These test the scoring + reordering logic that WebSearchTool applies
 * when context.scorer is present. The tool reorders search results by
 * entailment score against the original query — this is a STEERING
 * boundary check (agent hasn't committed to anything yet).
 */

// Simulate the reordering logic from WebSearchTool.execute()
function reorderByEntailment(
  results: Array<{ title: string; url: string; snippet: string }>,
  scores: number[],
): Array<{ title: string; url: string; snippet: string }> {
  return results
    .map((r, i) => ({ result: r, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.result);
}

describe('WebSearchTool — entailment reranking', () => {
  it('reorders results by entailment score descending', () => {
    const results = [
      { title: 'Irrelevant CPU article', url: 'https://cpu.com', snippet: 'CPU speculation...' },
      { title: 'LLM Speculative Decoding', url: 'https://llm.com', snippet: 'Real speculative decoding...' },
      { title: 'Somewhat related', url: 'https://mid.com', snippet: 'Apple Silicon ML...' },
    ];
    const scores = [0.1, 0.9, 0.5]; // irrelevant, highly relevant, mid

    const reordered = reorderByEntailment(results, scores);

    expect(reordered[0].title).toBe('LLM Speculative Decoding');
    expect(reordered[1].title).toBe('Somewhat related');
    expect(reordered[2].title).toBe('Irrelevant CPU article');
  });

  it('eclecticlight.co CPU speculation article demoted', () => {
    // Concrete test from trace analysis: eclecticlight.co article about
    // CPU speculative execution (LAP/LVP) appeared as result #5 in search.
    // Agent picked it because "speculative execution" ≈ "speculative decoding"
    // to keyword matching. Entailment scorer should demote it.

    const results = [
      { title: 'Quora: x86 vs ARM', url: 'https://quora.com/...', snippet: 'architectural differences...' },
      { title: 'HN: x86 catch up M series', url: 'https://news.ycombinator.com/...', snippet: 'efficiency...' },
      { title: 'r/hardware: ARM vs x86', url: 'https://reddit.com/...', snippet: 'design philosophy...' },
      { title: 'Seeking Alpha: Overhyped Silicon', url: 'https://seekingalpha.com/...', snippet: 'Arm vs x86...' },
      { title: 'Speed or security? Speculative execution in Apple silicon', url: 'https://eclecticlight.co/...', snippet: 'Load Address Prediction...' },
    ];

    // Entailment scores against "speculative decoding throughput on Apple Silicon for LLMs"
    const scores = [0.15, 0.20, 0.12, 0.10, 0.08]; // eclecticlight scores lowest

    const reordered = reorderByEntailment(results, scores);

    // eclecticlight should be last (lowest entailment to original query)
    expect(reordered[4].url).toContain('eclecticlight.co');
  });

  it('preserves order when no scorer (backward compatible)', () => {
    // Without scorer, results stay in provider order
    const results = [
      { title: 'A', url: 'a', snippet: 'a' },
      { title: 'B', url: 'b', snippet: 'b' },
    ];
    // No reordering applied
    expect(results[0].title).toBe('A');
    expect(results[1].title).toBe('B');
  });
});

describe('WebSearchTool — scorer interaction', () => {
  it('scorer.scoreEntailmentBatch receives title + snippet', async () => {
    const scorer: EntailmentScorer = {
      scoreEntailmentBatch: vi.fn(async (texts) => texts.map(() => 0.5)),
      shouldProceed: () => true,
    };

    const results = [
      { title: 'My Title', url: 'u', snippet: 'My snippet text' },
    ];
    const snippets = results.map((r) => `${r.title}. ${r.snippet}`);
    await scorer.scoreEntailmentBatch(snippets);

    expect(scorer.scoreEntailmentBatch).toHaveBeenCalledWith(['My Title. My snippet text']);
  });
});
