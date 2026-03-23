/**
 * Rig — research infrastructure for the lloyal agent pipeline
 *
 * The default export is RN-safe: no node:fs, no linkedom, no lloyal.node.
 * Platform-specific exports are available via sub-path imports:
 *
 * - `@lloyal-labs/rig/node` — Node.js-specific: createReranker, WebSource,
 *   CorpusSource, loadResources, chunkResources, FetchPageTool
 *
 * @packageDocumentation
 * @category Rig
 */

// Tools (all pure TS + Effection — RN-safe)
export {
  createTools, reportTool,
  ResearchTool, WebSearchTool, TavilyProvider,
  WebResearchTool, PlanTool,
} from './tools';
export type {
  ResearchToolOpts, WebResearchToolOpts, PlanToolOpts,
  PlanResult, PlanQuestion,
  SearchProvider, SearchResult,
  Reranker, ScoredChunk, ScoredResult,
} from './tools';

// Chunking (pure TS — RN-safe)
export { chunkFetchedPages } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Source types (pure TS — RN-safe)
export type { SourceContext } from './sources/types';

// Resource types (pure TS — RN-safe)
export type { Resource, Chunk } from './resources/types';
