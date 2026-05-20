import { createToolkit } from '@lloyal-labs/lloyal-agents';
import type { Toolkit } from '@lloyal-labs/lloyal-agents';
import type { Resource, Chunk } from '../resources/types';
import type { Reranker } from './types';
import { SearchTool } from './search';
import { ReadFileTool } from './read-file';
import { GrepTool } from './grep';
import { ReportTool } from './report';

export { WebSearchTool, TavilyProvider } from './web-search';
export { createKeylessSearchProvider } from './keyless-search';
export type { KeylessSearchOptions } from './keyless-search';
export { FetchPageTool } from './fetch-page';
export { ReportTool } from './report';
export { DelegateTool } from './delegate';
export type { DelegateToolOpts } from './delegate';
export type { SearchProvider, SearchResult, Reranker, ScoredChunk, ScoredResult } from './types';
export { PlanTool, taskToContent } from './plan';
export type { PlanResult, PlanIntent, PlanToolOpts, ResearchTask } from './plan';

/**
 * Shared {@link ReportTool} instance — the conventional terminal tool.
 *
 * `ReportTool` is stateless, so one shared instance is reused across
 * pools. Pass it as the `terminal` of `agentPool` / `useAgent`. For a
 * custom description, construct your own via `new ReportTool({...})`.
 *
 * @category Rig
 */
export const reportTool = new ReportTool();

/**
 * Build the standard corpus toolkit.
 *
 * Returns a {@link Toolkit} containing {@link SearchTool},
 * {@link ReadFileTool}, {@link GrepTool} as capability tools, with
 * {@link reportTool} as the designated terminal.
 *
 * @category Rig
 */
export function createTools(opts: {
  resources: Resource[];
  chunks: Chunk[];
  reranker: Reranker;
}): Toolkit {
  return createToolkit(
    [
      new SearchTool(opts.chunks, opts.reranker),
      new ReadFileTool(opts.resources),
      new GrepTool(opts.resources),
    ],
    reportTool,
  );
}
