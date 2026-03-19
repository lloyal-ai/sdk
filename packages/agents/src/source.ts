import type { Operation } from 'effection';
import type { Tool } from './Tool';

/**
 * Abstract base class for data sources usable by the research pipeline
 *
 * Each source builds its own atomic research tool — a self-contained
 * swarm with source-specific prompt, toolkit, and self-referential
 * recursion. The orchestrator sees only source research tools + report.
 *
 * @typeParam TCtx - Runtime context passed to {@link bind} (e.g. parent branch, reranker)
 * @typeParam TChunk - Chunk type returned by {@link getChunks} for post-research reranking
 *
 * @category Agents
 */
export abstract class Source<TCtx = Record<string, unknown>, TChunk = unknown> {
  /** Human-readable source name (e.g. 'web', 'corpus') for labeling findings */
  abstract readonly name: string;
  /** The configured research tool — atomic swarm with source-specific prompt + toolkit */
  abstract get researchTool(): Tool;

  /** Late-bind runtime deps not available at construction. Called before tools are used. */
  *bind(_ctx: TCtx): Operation<void> {}
  /** Post-research chunks for reranking. Called after research completes. */
  getChunks(): TChunk[] { return []; }
  /** Grounding tools for independent verification (e.g. search, read_file, grep). Empty by default. */
  get groundingTools(): Tool[] { return []; }
}
