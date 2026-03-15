import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool, Trace } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '../resources/types';
import type { Reranker, ScoredChunk } from './types';

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

    const results: ScoredChunk[] = yield* call(async () => {
      let last: ScoredChunk[] = [];
      for await (const { results, filled, total } of reranker.score(query, chunks)) {
        if (context?.onProgress) context.onProgress({ filled, total });
        last = results;
      }
      return last;
    });

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
