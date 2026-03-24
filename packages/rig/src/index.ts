/**
 * Rig — research infrastructure for the lloyal agent pipeline
 *
 * The default export is platform-agnostic. linkedom + @mozilla/readability
 * are pure JS and work in both Node.js and React Native (Hermes).
 *
 * Node-specific exports (createReranker, WebSource, CorpusSource,
 * loadResources, chunkResources) require node:fs and are available
 * via `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */

// Tools (pure TS + Effection + linkedom — platform-agnostic)
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

// Chunking (platform-agnostic — linkedom is pure JS)
export { chunkFetchedPages, chunkHtml } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Source types (pure TS — RN-safe)
export type { SourceContext } from './sources/types';

// Resource types (pure TS — RN-safe)
export type { Resource, Chunk } from './resources/types';
