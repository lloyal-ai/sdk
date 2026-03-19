/**
 * Rig — research infrastructure for the lloyal agent pipeline
 *
 * Provides source implementations ({@link WebSource}, {@link CorpusSource}),
 * resource loading/chunking, reranking, and the tool library used by
 * deep-research harnesses. Sources are composed via the abstract
 * {@link Source} base class from `@lloyal-labs/lloyal-agents`.
 *
 * @packageDocumentation
 * @category Rig
 */

// Tools
export {
  createTools, reportTool,
  ResearchTool, WebSearchTool, TavilyProvider, FetchPageTool,
  WebResearchTool, PlanTool,
} from './tools';
export type {
  ResearchToolOpts, WebResearchToolOpts, PlanToolOpts,
  PlanResult, PlanQuestion,
  SearchProvider, SearchResult,
  Reranker, ScoredChunk, ScoredResult,
} from './tools';

// Sources
export { WebSource, CorpusSource } from './sources';
export type { SourceContext } from './sources';

// Resources
export { loadResources, chunkResources } from './resources';
export type { Resource, Chunk } from './resources';

// Reranker
export { createReranker } from './reranker';
