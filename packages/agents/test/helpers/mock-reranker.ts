/**
 * Mock reranker for unit tests.
 * scoreBatch returns predictable scores from a lookup map.
 * Default score is 0.5 for texts not in the map.
 */
export function createMockReranker(scoreMap?: Map<string, number>) {
  const defaultScore = 0.5;
  return {
    score: async function* (_query: string, chunks: Array<{ resource: string; heading: string; startLine: number; endLine: number }>) {
      yield {
        filled: chunks.length,
        total: chunks.length,
        results: chunks.map((c, i) => ({
          file: c.resource,
          heading: c.heading,
          score: defaultScore,
          startLine: c.startLine,
          endLine: c.endLine,
        })),
      };
    },
    scoreBatch: async (_query: string, texts: string[]): Promise<number[]> =>
      texts.map((t) => scoreMap?.get(t) ?? defaultScore),
    tokenizeChunks: async (chunks: Array<{ tokens: number[] }>) => {
      for (const c of chunks) c.tokens = [1, 2, 3];
    },
    dispose: () => {},
  };
}
