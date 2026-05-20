import type { Tool } from './Tool';

/**
 * The compiled tool set an agent pool operates with: the assembled tool
 * instances plus the two projections the runtime needs and the name of
 * the designated terminal (if any).
 *
 * `createToolkit` is the single place a `Tool[]` (plus an optional
 * terminal) is turned into the shapes the framework consumes. Nothing
 * downstream consumes a `Toolkit` as a whole — the formatter reads
 * `toolsJson`, the pool reads `toolMap` and `terminalName` — so this is
 * internal plumbing, not a developer-facing concept. Harnesses pass
 * `tools: Tool[]` + `terminal?: Tool` to `agentPool` / `useAgent`; the
 * wrappers call `createToolkit` for them.
 *
 * @category Agents
 */
export interface Toolkit {
  /**
   * The assembled tool set — the supplied tools plus the designated
   * terminal (if one was given and wasn't already present), deduped by
   * name. `toolMap` and `toolsJson` are derived from exactly this list.
   */
  tools: Tool[];
  /** Name-to-instance map used by {@link useAgentPool} for tool dispatch. */
  toolMap: Map<string, Tool>;
  /** JSON-serialized tool schemas passed to `formatChat()` via task specs. */
  toolsJson: string;
  /**
   * Name of the terminal tool, when one was designated via the
   * `terminal` argument. The pool intercepts a call to this tool at the
   * policy layer and extracts its `result` arg as the agent's return
   * value (capture-only — the terminal's `execute()` is not run).
   * Undefined when no terminal was designated (agent ends on
   * free-text/stop).
   */
  terminalName?: string;
}

/**
 * Compile a `Tool[]` (and an optional terminal) into a {@link Toolkit}.
 *
 * The `terminal` is the tool that ends an agent's turn — `report`,
 * `email`, `persistToDB`, whatever the harness designates. It's passed
 * by **reference** (not by name), so there's no string to mistype and
 * no "the terminal must also appear in the array" coupling: the terminal
 * is merged into the assembled set here (deduped if already present), so
 * its schema reaches the model and its instance is dispatchable, and its
 * name is recorded as {@link Toolkit.terminalName}.
 *
 * @param tools - The agent's non-terminal tools (app/source tools, or
 *   harness-constructed tools).
 * @param terminal - Optional terminal tool. Omit for pools that end on
 *   free-text/stop.
 *
 * @example
 * ```typescript
 * const toolkit = createToolkit(
 *   [new SearchTool(chunks, reranker), new ReadFileTool(resources)],
 *   reportTool,
 * );
 * ```
 *
 * @category Agents
 */
export function createToolkit(tools: Tool[], terminal?: Tool): Toolkit {
  const merged =
    terminal && !tools.some(t => t.name === terminal.name)
      ? [...tools, terminal]
      : tools;
  return {
    tools: merged,
    toolMap: new Map(merged.map(t => [t.name, t])),
    toolsJson: JSON.stringify(merged.map(t => t.schema)),
    terminalName: terminal?.name,
  };
}
