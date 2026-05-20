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
  WebSearchTool, TavilyProvider, createKeylessSearchProvider, FetchPageTool,
  DelegateTool,
  PlanTool, taskToContent,
} from './tools';
export type {
  DelegateToolOpts,
  KeylessSearchOptions,
  PlanToolOpts,
  PlanResult, PlanIntent, ResearchTask,
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

// HDK 3.0 App Contract surfaces (RFC §5)
export {
  BOUNDARY_MARKER,
  FRAMEWORK_INTRO,
  TOOL_SELECTION_RULE,
  CATALOG_ENTRY,
  VALIDATED_MODELS_3_0,
  MODEL_CONTRACT_VERSION,
  SUPPORTED_MODEL_CONTRACT_VERSIONS,
} from './contract';
export { defineApp } from './define-app';
export { cancellableFetch, FetchTimeoutError } from './cancellable-fetch';
export { createInMemoryConfigStore } from './config-store';
export { createAppRegistry } from './registry';
export type { CreateAppRegistryOpts } from './registry';
export { verifyBundle, loadBundle, BundleVerificationError } from './bundle';
export type { AppBundleManifest, LoadBundleOptions } from './bundle';
export { renderSpine, renderAgentPreamble } from './spine-render';
export type { RenderSpineOptions } from './spine-render';
