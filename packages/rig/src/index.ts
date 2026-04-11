/**
 * Rig — data sources and tools for the lloyal agent pipeline
 *
 * The default export is platform-agnostic. linkedom + @mozilla/readability
 * are pure JS and work in both Node.js and React Native (Hermes).
 *
 * Node-specific exports (createReranker, loadResources, chunkResources)
 * require node:fs and are available via `@lloyal-labs/rig/node`.
 *
 * @packageDocumentation
 * @category Rig
 */

// Tools (pure TS + Effection + linkedom — platform-agnostic)
export {
  createTools, reportTool, ReportTool,
  WebSearchTool, TavilyProvider, FetchPageTool,
  PlanTool, taskToContent,
} from './tools';
export type {
  PlanToolOpts,
  PlanResult, PlanQuestion, ResearchTask,
  SearchProvider, SearchResult,
  Reranker, ScoredChunk, ScoredResult,
} from './tools';

// Sources (platform-agnostic — no node:fs)
export { WebSource } from './sources/web';
export type { WebSourceOpts } from './sources/web';
export { CorpusSource } from './sources/corpus';
export type { CorpusSourceOpts, CorpusPromptData } from './sources/corpus';
export type { SourceContext } from './sources/types';

// Chunking (platform-agnostic — linkedom is pure JS)
export { chunkFetchedPages, chunkHtml } from './sources/chunking';
export type { FetchedPage } from './sources/chunking';

// Resource types (pure TS — RN-safe)
export type { Resource, Chunk } from './resources/types';
