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

export const reportTool = new ReportTool();

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
