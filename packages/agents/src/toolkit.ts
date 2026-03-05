import type { Tool } from './Tool';

/**
 * Aggregated tool registry for agent pool consumption
 *
 * Contains the `toolMap` for dispatch and `toolsJson` for prompt
 * formatting. Created by {@link createToolkit}.
 *
 * @category Agents
 */
export interface Toolkit {
  /** Name-to-instance map used by {@link useAgentPool} for tool dispatch */
  toolMap: Map<string, Tool>;
  /** JSON-serialized tool schemas passed to `formatChat()` via task specs */
  toolsJson: string;
}

/**
 * Aggregate an array of {@link Tool} instances into a toolkit
 *
 * Builds both the dispatch map and the JSON schema string from the
 * tool array. Pass the result directly to {@link AgentPoolOptions}
 * and {@link AgentTaskSpec}.
 *
 * @param tools - Tool instances to aggregate
 * @returns Toolkit with `toolMap` and `toolsJson`
 *
 * @example
 * ```typescript
 * const { toolMap, toolsJson } = createToolkit([
 *   new SearchTool(chunks, reranker),
 *   new ReadFileTool(resources),
 *   new GrepTool(resources),
 * ]);
 * ```
 *
 * @category Agents
 */
export function createToolkit(tools: Tool[]): Toolkit {
  return {
    toolMap: new Map(tools.map(t => [t.name, t])),
    toolsJson: JSON.stringify(tools.map(t => t.schema)),
  };
}
