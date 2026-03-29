import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '../resources/types';
import type { Reranker, ScoredChunk } from './types';

/**
 * Semantic search over corpus chunks via a {@link Reranker}
 *
 * Scores all chunks against the query and returns ranked results
 * with file names, headings, scores, and line ranges. Progress is
 * reported through the optional {@link ToolContext.onProgress}
 * callback as the reranker streams intermediate results.
 *
 * @example
 * ```typescript
 * const search = new SearchTool(chunks, reranker);
 * ```
 *
 * @category Rig
 */
export class SearchTool extends Tool<{ query: string }> {
  readonly name = 'search';
  readonly description = 'Search the knowledge base. Returns sections ranked by relevance with line ranges for read_file.';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string', description: 'Search query' } },
    required: ['query'],
  };

  private _chunks: Chunk[];
  private _reranker: Reranker;

  constructor(chunks: Chunk[], reranker: Reranker) {
    super();
    this._chunks = chunks;
    this._reranker = reranker;
  }

  *execute(args: { query: string }, context?: ToolContext): Operation<unknown> {
    const query = args.query?.trim();
    if (!query) return { error: 'query must not be empty' };
    const tw = yield* Trace.expect();
    const reranker = this._reranker;
    const chunks = this._chunks;

    const t0 = performance.now();
    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: t0,
      type: 'rerank:start', query, chunkCount: chunks.length,
    });

    let results: ScoredChunk[] = yield* call(async () => {
      let last: ScoredChunk[] = [];
      for await (const { results, filled, total } of reranker.score(query, chunks)) {
        if (context?.onProgress) context.onProgress({ filled, total });
        last = results;
      }
      return last;
    });

    // Explore mode (default): agent-local scoring only. Agents discover
    // bridging content (adjacent sections connecting investigation to answer).
    // Scoring against the original query would demote exactly that content.
    //
    // Exploit mode (!explore): dual scoring via scoreRelevanceBatch —
    // min(toolQueryScore, originalQueryScore) per chunk. Tightens focus
    // when KV headroom is low, at the cost of serendipitous discovery.
    if (!context?.explore && context?.scorer && results.length > 0) {
      type ScoredWithOriginal = ScoredChunk & { _toolQueryScore: number };
      const chunkTexts = results.map((sc) => {
        const chunk = chunks.find(c => c.resource === sc.file && c.startLine === sc.startLine);
        return chunk?.text ?? '';
      });
      const combinedScores: number[] = yield* call(() =>
        context.scorer!.scoreRelevanceBatch(chunkTexts, query),
      );
      const reordered: ScoredWithOriginal[] = results
        .map((sc, i) => ({ ...sc, score: combinedScores[i], _toolQueryScore: sc.score }))
        .sort((a, b) => b.score - a.score);
      results = reordered;

      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'entailment:content:exploit', tool: 'search',
        pressure: {
          percentAvailable: context.pressurePercentAvailable ?? -1,
          remaining: -1,
          nCtx: -1,
        },
        chunks: reordered.slice(0, 5).map((sc) => ({
          heading: sc.heading,
          toolQueryScore: sc._toolQueryScore,
          combinedScore: sc.score,
        })),
      });
    }

    tw.write({
      traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
      type: 'rerank:end',
      topResults: results.slice(0, 5).map(r => ({ file: r.file, heading: r.heading, score: r.score })),
      selectedPassageCount: results.length,
      totalChars: 0,
      durationMs: performance.now() - t0,
    });

    return results;
  }
}
