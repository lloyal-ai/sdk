import { createToolkit } from '@lloyal-labs/lloyal-agents';
import type { Toolkit } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '../resources/types';
import type { Reranker } from './types';
import { SearchTool } from './search';
import { ReadFileTool } from './read-file';
import { GrepTool } from './grep';
import { ReportTool } from './report';

export { WebSearchTool, TavilyProvider } from './web-search';
export { FetchPageTool } from './fetch-page';
export { ReportTool } from './report';
export { DelegateTool } from './delegate';
export type { DelegateToolOpts } from './delegate';
export type { SearchProvider, SearchResult, Reranker, ScoredChunk, ScoredResult } from './types';
export { PlanTool, taskToContent } from './plan';
export type { PlanResult, PlanQuestion, PlanToolOpts, ResearchTask } from './plan';

/**
 * Shared singleton {@link ReportTool} instance.
 *
 * Re-used across toolkits since ReportTool is stateless.
 *
 * @category Rig
 */
export const reportTool = new ReportTool();

/**
 * Build the standard corpus toolkit.
 *
 * Returns a {@link Toolkit} containing {@link SearchTool},
 * {@link ReadFileTool}, {@link GrepTool}, and {@link ReportTool}
 * wired to the provided resources, chunks, and reranker.
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
