import type { Operation } from 'effection';
import type { Tool } from './Tool';

/**
 * Abstract base class for data sources
 *
 * A source is a named collection of data access tools with a bind
 * lifecycle. It does not orchestrate agents — that is the harness's
 * job via {@link spawnAgents}.
 *
 * @typeParam TCtx - Runtime context passed to {@link bind} (e.g. reranker)
 * @typeParam TChunk - Chunk type returned by {@link getChunks} for post-use reranking
 *
 * @category Agents
 */
export abstract class Source<TCtx = unknown, TChunk = unknown> {
  /** Human-readable source name (e.g. 'web', 'corpus') for labeling output */
  abstract readonly name: string;
  /** Data access tools provided by this source */
  abstract get tools(): Tool[];

  /** Late-bind runtime deps not available at construction. Called before tools are used. */
  *bind(_ctx: TCtx): Operation<void> {}
  /** Post-use chunks for reranking. Called after agents have used the tools. */
  getChunks(): TChunk[] { return []; }
}
