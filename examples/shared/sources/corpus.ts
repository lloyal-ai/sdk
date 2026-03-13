import { call } from 'effection';
import type { Operation } from 'effection';
import { Source } from '@lloyal-labs/lloyal-agents';
import type { Tool } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '../resources/types';
import type { SourceContext } from './types';
import { SearchTool } from '../tools/search';
import { ReadFileTool } from '../tools/read-file';
import { GrepTool } from '../tools/grep';

export class CorpusSource extends Source<SourceContext, Chunk> {
  private _chunks: Chunk[];
  private _tools: Tool[] = [];
  private _bound = false;

  readonly toolGuide = [
    '- **grep**: regex pattern matching — use short patterns, single keywords or two-word phrases',
    '- **search**: semantic relevance ranking — use to discover content grep may miss',
    '- **read_file**: read specific line ranges — use to verify matches in context',
  ].join('\n');

  readonly processSteps = [
    '1. Grep with short, simple patterns first. Use single keywords or two-word phrases.',
    '2. Use search to discover content that grep may miss (different phrasing, synonyms).',
    '3. Read every matching line with read_file to verify in context.',
    '4. Grep again with a different pattern targeting what you have NOT yet found.',
  ].join('\n');

  constructor(resources: Resource[], chunks: Chunk[]) {
    super();
    this._chunks = chunks;
    this._tools = [
      new ReadFileTool(resources),
      new GrepTool(resources),
    ];
  }

  get tools(): Tool[] { return this._tools; }

  *bind(ctx: SourceContext): Operation<void> {
    if (this._bound) return;
    yield* call(() => ctx.reranker.tokenizeChunks(this._chunks));
    this._tools.unshift(new SearchTool(this._chunks, ctx.reranker));
    this._bound = true;
  }
}
