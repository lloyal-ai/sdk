import type { JsonSchema, ToolSchema, ToolContext } from './types';

/**
 * Abstract base class for tools usable by agents in the runtime
 *
 * Subclass to define tools that agents can invoke during generation.
 * Implement `name`, `description`, `parameters`, and `execute()`. The
 * {@link schema} getter auto-generates the OpenAI-compatible function
 * schema expected by `formatChat()`.
 *
 * Pass tool instances to {@link createToolkit} to build the `toolMap`
 * and `toolsJson` pair consumed by {@link useAgentPool} and
 * {@link runAgents}.
 *
 * @example Search tool
 * ```typescript
 * class SearchTool extends Tool<{ query: string; topK?: number }> {
 *   readonly name = 'search';
 *   readonly description = 'Search the corpus for relevant passages';
 *   readonly parameters = {
 *     type: 'object',
 *     properties: {
 *       query: { type: 'string', description: 'Search query' },
 *       topK: { type: 'number', description: 'Number of results' },
 *     },
 *     required: ['query'],
 *   };
 *
 *   async execute(args: { query: string; topK?: number }, ctx?: ToolContext) {
 *     const results = await this.reranker.rank(args.query, args.topK ?? 5);
 *     return { results };
 *   }
 * }
 * ```
 *
 * @category Agents
 */
export abstract class Tool<TArgs = Record<string, unknown>> {
  /** Tool name — used as the function identifier in tool calls */
  abstract readonly name: string;
  /** Human-readable description shown to the model */
  abstract readonly description: string;
  /** JSON Schema describing the tool's expected arguments */
  abstract readonly parameters: JsonSchema;

  /**
   * Execute the tool with parsed arguments
   *
   * Called by the agent pool when the model emits a tool call matching
   * this tool's name. The return value is JSON-serialized and prefilled
   * back into the agent's context as a tool result.
   *
   * @param args - Parsed arguments from the model's tool call
   * @param context - Execution context with progress reporting callback
   * @returns Tool result (will be JSON-serialized)
   */
  abstract execute(args: TArgs, context?: ToolContext): Promise<unknown>;

  /**
   * OpenAI-compatible function tool schema
   *
   * Auto-generated from `name`, `description`, and `parameters`.
   * Used by {@link createToolkit} to build the JSON string passed
   * to `formatChat()`.
   */
  get schema(): ToolSchema {
    return {
      type: 'function',
      function: {
        name: this.name,
        description: this.description,
        parameters: this.parameters,
      },
    };
  }
}
