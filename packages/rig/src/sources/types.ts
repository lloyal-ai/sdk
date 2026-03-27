import type { Reranker } from '../tools/types';

/**
 * Runtime context passed to {@link Source.bind} during pipeline setup.
 *
 * Carries the reranker instance needed by corpus sources to tokenize
 * chunks and by web sources for fetch-page chunk scoring. Orchestration
 * config (prompts, maxTurns, tools) belongs in {@link spawnAgents} opts,
 * not in the source context.
 *
 * @category Rig
 */
export interface SourceContext {
  /** Reranker instance for chunk tokenization and scoring */
  reranker: Reranker;
}
