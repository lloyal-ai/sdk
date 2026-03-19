import { createContext } from "@lloyal-labs/lloyal.node";
import { Rerank } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import type { Chunk } from "./resources/types";
import type { Reranker, ScoredResult } from "./tools/types";

/**
 * Create a {@link Reranker} backed by a dedicated reranking model context
 *
 * Loads a separate model (typically a cross-encoder) into its own KV cache
 * and exposes `score`, `tokenizeChunks`, and `dispose` methods. The returned
 * `score` method yields {@link ScoredResult} batches as an async iterable,
 * mapping raw indices back to the original {@link Chunk} metadata.
 *
 * @param modelPath - Absolute path to the reranking model file (GGUF)
 * @param opts - Optional context sizing overrides
 * @param opts.nSeqMax - Maximum parallel scoring sequences (default 8)
 * @param opts.nCtx - Context window size for the reranker model (default 4096)
 * @returns A ready-to-use reranker instance; call `dispose()` when finished
 *
 * @category Rig
 */
export async function createReranker(
  modelPath: string,
  opts?: { nSeqMax?: number; nCtx?: number },
): Promise<Reranker> {
  const nSeqMax = opts?.nSeqMax ?? 8;
  const nCtx = opts?.nCtx ?? 4096;
  const ctx = await createContext({
    modelPath,
    nCtx,
    nSeqMax,
    typeK: 'q4_0',
    typeV: 'q4_0',
  });
  const rerank = await Rerank.create(ctx as unknown as SessionContext, { nSeqMax, nCtx });

  return {
    score(query: string, chunks: Chunk[]): AsyncIterable<ScoredResult> {
      const inner = rerank.score(
        query,
        chunks.map((c) => c.tokens),
        10,
      );
      return {
        [Symbol.asyncIterator](): AsyncIterator<ScoredResult> {
          const it = inner[Symbol.asyncIterator]();
          return {
            async next(): Promise<IteratorResult<ScoredResult>> {
              const { value, done } = await it.next();
              if (done)
                return {
                  value: undefined as unknown as ScoredResult,
                  done: true,
                };
              return {
                value: {
                  filled: value.filled,
                  total: value.total,
                  results: value.results.map((r) => ({
                    file: chunks[r.index].resource,
                    heading: chunks[r.index].heading,
                    score: r.score,
                    startLine: chunks[r.index].startLine,
                    endLine: chunks[r.index].endLine,
                  })),
                },
                done: false,
              };
            },
          };
        },
      };
    },

    async tokenizeChunks(chunks: Chunk[]): Promise<void> {
      for (const chunk of chunks) {
        chunk.tokens = await rerank.tokenize(chunk.text);
      }
    },

    dispose() {
      rerank.dispose();
    },
  };
}
