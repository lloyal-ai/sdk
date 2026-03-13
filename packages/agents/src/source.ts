import type { Operation } from 'effection';
import type { Tool } from './Tool';

/**
 * Abstract base class for data sources usable by the research pipeline
 *
 * Parallels {@link Tool} — subclass to define a source that provides
 * tools, prompt fragments, and post-research chunks. Each source
 * contributes tools (e.g. web_search, grep) and prompt guidance
 * that gets composed into the research system prompt at runtime.
 *
 * @typeParam TCtx - Runtime context passed to {@link bind} (e.g. parent branch, reranker)
 * @typeParam TChunk - Chunk type returned by {@link getChunks} for post-research reranking
 *
 * @category Agents
 */
export abstract class Source<TCtx = Record<string, unknown>, TChunk = unknown> {
  /** Tool descriptions for the research system prompt (markdown list items) */
  abstract readonly toolGuide: string;
  /** Complete process steps for this source's tools */
  abstract readonly processSteps: string;
  /** Tool instances this source provides */
  abstract get tools(): Tool[];

  /** Late-bind runtime deps not available at construction. Called before tools are used. */
  *bind(_ctx: TCtx): Operation<void> {}
  /** Post-research chunks for reranking. Called after research completes. */
  getChunks(): TChunk[] { return []; }
}
