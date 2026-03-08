import { call } from 'effection';
import type { Operation } from 'effection';
import { Tool } from '@lloyal-labs/lloyal-agents';
import type { JsonSchema, ToolContext } from '@lloyal-labs/lloyal-agents';
import type { Chunk } from '../resources/types';
import type { Reranker } from './types';

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
    const reranker = this._reranker;
    const chunks = this._chunks;
    return yield* call(async () => {
      let last;
      for await (const { results, filled, total } of reranker.score(query, chunks)) {
        if (context?.onProgress) context.onProgress({ filled, total });
        last = results;
      }
      return last;
    });
  }
}
