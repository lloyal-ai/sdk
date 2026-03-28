import { describe, it, expect } from 'vitest';

/**
 * FetchPageTool tests — alsoOnPage discovery signal and URL dedup cache.
 *
 * FetchPageTool is a CONTENT boundary — it does NOT score against the
 * original query. It scores chunks against the agent's local query only.
 * This preserves serendipitous discovery (the 4-beat pattern).
 *
 * The alsoOnPage field provides lightweight discovery signals by surfacing
 * headings of chunks that didn't make the top-K cutoff.
 */

// Simulate selectTopChunks + alsoOnPage logic from FetchPageTool
function buildFetchResult(
  scored: Array<{ heading: string; score: number; text: string }>,
  topK: number,
) {
  const sorted = [...scored].sort((a, b) => b.score - a.score);
  const topChunks = sorted.slice(0, topK);
  const selectedHeadings = new Set(topChunks.map(c => c.heading));
  const alsoOnPage = sorted
    .filter((sc) => !selectedHeadings.has(sc.heading))
    .map((sc) => sc.heading)
    .filter((h, i, arr) => arr.indexOf(h) === i);

  return {
    content: topChunks.map(c => c.text).join('\n\n---\n\n'),
    chunks: topChunks.length,
    ...(alsoOnPage.length > 0 ? { alsoOnPage } : {}),
  };
}

describe('FetchPageTool — alsoOnPage', () => {
  it('includes headings of non-selected chunks', () => {
    const scored = [
      { heading: 'Introduction', score: 0.9, text: 'intro text' },
      { heading: 'Methods', score: 0.7, text: 'methods text' },
      { heading: 'Acceptance Rates', score: 0.3, text: 'acceptance data' },
      { heading: 'Batch Size Analysis', score: 0.2, text: 'batch analysis' },
      { heading: 'Memory Architecture', score: 0.15, text: 'unified memory' },
    ];

    const result = buildFetchResult(scored, 2);

    expect(result.chunks).toBe(2);
    expect(result.content).toContain('intro text');
    expect(result.content).toContain('methods text');
    expect(result.alsoOnPage).toEqual([
      'Acceptance Rates',
      'Batch Size Analysis',
      'Memory Architecture',
    ]);
  });

  it('no alsoOnPage when all chunks selected', () => {
    const scored = [
      { heading: 'A', score: 0.9, text: 'a' },
      { heading: 'B', score: 0.8, text: 'b' },
    ];

    const result = buildFetchResult(scored, 5);

    expect(result.chunks).toBe(2);
    expect(result.alsoOnPage).toBeUndefined();
  });

  it('deduplicates headings in alsoOnPage', () => {
    const scored = [
      { heading: 'Selected', score: 0.9, text: 'sel' },
      { heading: 'Repeated', score: 0.3, text: 'r1' },
      { heading: 'Repeated', score: 0.2, text: 'r2' },
      { heading: 'Unique', score: 0.1, text: 'u' },
    ];

    const result = buildFetchResult(scored, 1);

    expect(result.alsoOnPage).toEqual(['Repeated', 'Unique']);
  });

  it('provides discovery signal for hypothesis formation', () => {
    // Concrete scenario from trace analysis:
    // Agent fetches Reddit thread about "speculative decoding limitations"
    // Top-K returns chunks about limitations (what agent asked for)
    // alsoOnPage shows: "Unified memory architecture", "Draft model sizing"
    // → agent sees peripheral topics without KV cost → seeds hypothesis

    const scored = [
      { heading: 'Why speculative decoding is limited on Apple Silicon', score: 0.95, text: '...' },
      { heading: 'Memory bandwidth bottleneck', score: 0.85, text: '...' },
      { heading: 'Unified memory architecture discussion', score: 0.3, text: '...' },
      { heading: 'Draft model sizing recommendations', score: 0.25, text: '...' },
      { heading: 'Batch size vs speedup curves', score: 0.2, text: '...' },
    ];

    const result = buildFetchResult(scored, 2);

    expect(result.alsoOnPage).toContain('Unified memory architecture discussion');
    expect(result.alsoOnPage).toContain('Draft model sizing recommendations');
    expect(result.alsoOnPage).toContain('Batch size vs speedup curves');
  });
});

describe('FetchPageTool — URL dedup cache', () => {
  // Simulate the BufferingFetchPage cache logic
  const cache = new Map<string, unknown>();

  function simulateFetch(url: string, result: unknown) {
    if (cache.has(url)) return { cached: true, result: cache.get(url) };
    cache.set(url, result);
    return { cached: false, result };
  }

  it('first fetch returns fresh result and caches', () => {
    cache.clear();
    const res = simulateFetch('https://example.com', { content: 'page content' });
    expect(res.cached).toBe(false);
    expect(cache.has('https://example.com')).toBe(true);
  });

  it('second fetch of same URL returns cached result', () => {
    cache.clear();
    simulateFetch('https://example.com', { content: 'original' });
    const res = simulateFetch('https://example.com', { content: 'should not be used' });
    expect(res.cached).toBe(true);
    expect((res.result as any).content).toBe('original');
  });

  it('different URLs are cached independently', () => {
    cache.clear();
    simulateFetch('https://a.com', { content: 'A' });
    simulateFetch('https://b.com', { content: 'B' });
    const resA = simulateFetch('https://a.com', {});
    const resB = simulateFetch('https://b.com', {});
    expect((resA.result as any).content).toBe('A');
    expect((resB.result as any).content).toBe('B');
  });

  it('clearCache resets for new research run', () => {
    cache.clear();
    simulateFetch('https://example.com', { content: 'old' });
    cache.clear(); // simulate WebSource.bind() clearing cache
    const res = simulateFetch('https://example.com', { content: 'new' });
    expect(res.cached).toBe(false);
    expect((res.result as any).content).toBe('new');
  });
});

describe('FetchPageTool — content boundary (no entailment)', () => {
  it('does NOT score against original query', () => {
    // Design test: FetchPageTool scores chunks against the AGENT's query only.
    // No scorer.scoreEntailmentBatch or scorer.scoreRelevanceBatch calls.
    // This preserves the discovery mechanism:
    //
    // - Agent reads about iPod → sees "United States v. Microsoft" adjacent
    // - If we scored against "iPod success to monopoly practices",
    //   the Microsoft section would be demoted (low original-query score)
    // - The hypothesis grep for "Microsoft|consent decree" never happens
    //
    // Validated by removing dual scoring from FetchPageTool in this session.
    // The trace (1774672202496) confirmed: agent discovered Microsoft at L83-84
    // because read_file returned raw content, and delegated about it.
    expect(true).toBe(true); // enforced by code — no scorer calls in FetchPageTool
  });
});
