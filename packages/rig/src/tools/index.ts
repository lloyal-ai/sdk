import { createToolkit } from '@lloyal-labs/lloyal-agents';
import type { Toolkit } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '../resources/types';
import type { Reranker } from './types';
import { SearchTool } from './search';
import { ReadFileTool } from './read-file';
import { GrepTool } from './grep';
import { ReportTool } from './report';

export { ResearchTool } from './research';
export type { ResearchToolOpts } from './research';
export { WebSearchTool, TavilyProvider } from './web-search';
export { FetchPageTool } from './fetch-page';
export type { SearchProvider, SearchResult, Reranker, ScoredChunk, ScoredResult } from './types';
export { WebResearchTool } from './web-research';
export type { WebResearchToolOpts } from './web-research';
export { PlanTool } from './plan';
export type { PlanResult, PlanQuestion, PlanToolOpts } from './plan';

/**
 * Shared singleton {@link ReportTool} instance.
 *
 * Re-used across toolkits since ReportTool is stateless.
 *
 * @category Rig
 */
export const reportTool = new ReportTool();

/**
 * Build the standard corpus-research toolkit.
 *
 * Returns a {@link Toolkit} containing {@link SearchTool},
 * {@link ReadFileTool}, {@link GrepTool}, and {@link ReportTool}
 * wired to the provided resources, chunks, and reranker.
 *
 * @param opts - Resources, chunks, and reranker to bind into the tools.
 * @returns A ready-to-use toolkit for corpus research agents.
 *
 * @category Rig
 */
export function createTools(opts: {
  resources: Resource[];
  chunks: Chunk[];
  reranker: Reranker;
}): Toolkit {
  return createToolkit([
    new SearchTool(opts.chunks, opts.reranker),
    new ReadFileTool(opts.resources),
    new GrepTool(opts.resources),
    reportTool,
  ]);
}
