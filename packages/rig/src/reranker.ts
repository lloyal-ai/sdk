import { createContext } from "@lloyal-labs/lloyal.node";
import { Rerank } from "@lloyal-labs/sdk";
import type { SessionContext } from "@lloyal-labs/sdk";
import { resource, call } from "effection";
import type { Operation } from "effection";
import type { Chunk, Reranker, ScoredResult } from "@lloyal-labs/lloyal-agents";

/**
 * Create a {@link Reranker} backed by a dedicated reranking model context,
 * as an Effection `resource()` (RFC §6.1).
 *
 * Loads a separate model (typically a cross-encoder) into its own KV cache
 * and exposes `score`, `scoreBatch`, `tokenizeChunks`, and `dispose`. The
 * returned `score` method yields {@link ScoredResult} batches as an async
 * iterable, mapping raw indices back to the original {@link Chunk} metadata.
 *
 * **Lifecycle.** The reranker owns its underlying `SessionContext` + `Rerank`
 * and disposes them transitively when the yielding scope exits (success,
 * error, or halt). The harness yields it once per process lifecycle and
 * publishes it on `RerankerCtx` so App factories can read it via
 * `RerankerCtx.expect()` (RFC §6.3). `dispose()` remains on the interface
 * for callers that manage teardown explicitly; it is idempotent so the
 * resource finally and an explicit call don't double-free.
 *
 * @param modelPath - Absolute path to the reranking model file (GGUF)
 * @param opts - Optional context sizing overrides
 * @param opts.nSeqMax - Maximum parallel scoring sequences (default 8)
 * @param opts.nCtx - Context window size for the reranker model (default 4096)
 * @returns An Effection resource yielding a ready-to-use reranker
 *
 * @example
 * ```ts
 * const reranker = yield* createReranker(rerankerPath, { nSeqMax: 8, nCtx: 4096 });
 * yield* RerankerCtx.set(reranker);
 * // ... pool work ...
 * // reranker disposes automatically on scope exit
 * ```
 *
 * @category Rig
 */
export function createReranker(
  modelPath: string,
  opts?: { nSeqMax?: number; nCtx?: number; nBatch?: number },
): Operation<Reranker> {
  return resource(function* (provide) {
    const nSeqMax = opts?.nSeqMax ?? 8;
    const nCtx = opts?.nCtx ?? 4096;
    const nBatch = opts?.nBatch ?? Math.floor(nCtx / nSeqMax);
    const ctx = yield* call(() => createContext({
      modelPath,
      nCtx,
      nSeqMax,
      nBatch,
      typeK: 'q4_0',
      typeV: 'q4_0',
    }));
    const rerank = yield* call(() =>
      Rerank.create(ctx as unknown as SessionContext, { nSeqMax, nCtx }),
    );

    let disposed = false;
    const reranker: Reranker = {
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
                    section: chunks[r.index].section,
                    snippet: chunks[r.index].text.slice(0, 200),
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

    scoreBatch(query: string, texts: string[]): Promise<number[]> {
      return rerank.scoreBatch(query, texts);
    },

    async tokenizeChunks(chunks: Chunk[]): Promise<void> {
      for (const chunk of chunks) {
        chunk.tokens = await rerank.tokenize(chunk.text);
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      rerank.dispose();
    },
    };

    try {
      yield* provide(reranker);
    } finally {
      reranker.dispose();
    }
  });
}
