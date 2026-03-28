import type { Operation } from 'effection';
import { call } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { Tool } from './Tool';
import type { JsonSchema, ToolContext } from './types';
import type { AgentPoolResult, PressureThresholds } from './types';
import type { AgentPolicy } from './AgentPolicy';
import type { EntailmentScorer } from './source';
import { Trace } from './context';
import { traceScope } from './trace-scope';
import { createToolkit } from './toolkit';
import type { Toolkit } from './toolkit';
import { withSharedRoot } from './shared-root';
import { useAgentPool } from './agent-pool';

// ── Recursive tool opts ──────────────────────────────────────

/**
 * Configuration for the self-referential recursive tool.
 *
 * @category Agents
 */
export interface RecursiveOpts {
  /** Tool name agents see in their toolkit. @default "delegate" */
  name?: string;
  /** Tool description shown in the agent's tool schema. */
  description?: string;
  /**
   * JSON schema for the recursive tool's arguments.
   * @default `{ type: 'object', properties: { tasks: { type: 'array', items: { type: 'string' } } }, required: ['tasks'] }`
   */
  argsSchema?: JsonSchema;
  /**
   * Extract task strings from parsed tool arguments.
   * @default `(args) => args.tasks as string[]`
   */
  extractTasks?: (args: Record<string, unknown>) => string[];
}

// ── SpawnAgents opts ─────────────────────────────────────────

/**
 * Options for {@link spawnAgents}.
 *
 * @category Agents
 */
export interface SpawnAgentsOpts {
  /** Data access tools (from a Source or custom). */
  tools: Tool[];
  /** System prompt for spawned agents. */
  systemPrompt: string;
  /** One task per agent — content string for each. */
  tasks: string[];
  /** Terminal tool name + instance. Pool intercepts calls to this tool and extracts results. */
  terminalTool?: { name: string; tool: Tool };
  /** Max tool-use turns per agent before hard cut. @default 100 */
  maxTurns?: number;
  /**
   * Enable self-referential recursion. When truthy, a wrapper tool is
   * added to the toolkit that calls `spawnAgents()` recursively with
   * the same config. Agents can delegate sub-tasks at arbitrary depth,
   * bounded by KV pressure.
   *
   * Pass `true` for defaults, or an object to configure the tool's
   * name, description, args schema, and task extraction.
   */
  recursive?: boolean | RecursiveOpts;
  /** Scratchpad extraction for agents killed before reporting. */
  extractionPrompt?: {
    system: string;
    user: string;
    minTokens?: number;
    minToolCalls?: number;
  };
  /** Prune agent branches immediately on report, freeing KV mid-pool. */
  pruneOnReport?: boolean;
  /** KV pressure thresholds for the agent pool. */
  pressure?: PressureThresholds;
  /** Custom agent policy. @default DefaultAgentPolicy */
  policy?: AgentPolicy;
  /** Enable structured trace events. */
  trace?: boolean;
  /** Parent branch for warm path (Continuous Context). Sub-agents inherit full attention state. */
  parent?: Branch;
  /** Entailment scorer for semantic coherence across recursive depths.
   *  Created via {@link Source.createScorer}. Propagated to all inner pools. */
  scorer?: EntailmentScorer;
}

// ── Recursive tool ───────────────────────────────────────────

const DEFAULT_ARGS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: { type: 'string' },
      description: 'Sub-tasks to delegate to parallel agents',
    },
  },
  required: ['tasks'],
};

/**
 * Internal tool that calls spawnAgents() recursively.
 * Created by spawnAgents() when `recursive` is enabled.
 */
class DelegateTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;

  private _spawnOpts: SpawnAgentsOpts;
  private _extractTasks: (args: Record<string, unknown>) => string[];
  private _toolkit: Toolkit | null = null;

  constructor(
    name: string,
    description: string,
    argsSchema: JsonSchema,
    extractTasks: (args: Record<string, unknown>) => string[],
    spawnOpts: SpawnAgentsOpts,
  ) {
    super();
    this.name = name;
    this.description = description;
    this.parameters = argsSchema;
    this._extractTasks = extractTasks;
    this._spawnOpts = spawnOpts;
  }

  /** Wire the circular toolkit reference. Called after createToolkit(). */
  setToolkit(toolkit: Toolkit): void {
    this._toolkit = toolkit;
  }

  *execute(args: Record<string, unknown>, context?: ToolContext): Operation<unknown> {
    let tasks: string[];
    try {
      tasks = this._extractTasks(args);
    } catch {
      return { error: 'Failed to extract tasks from arguments.' };
    }
    if (!Array.isArray(tasks) || tasks.length === 0) {
      return { error: 'Tasks must be a non-empty array of strings.' };
    }

    if (!this._toolkit) {
      throw new Error(`${this.name}: toolkit not wired. Internal error.`);
    }

    const tw = yield* Trace.expect();

    // Entailment gate: filter drifted/echoed tasks before spawning
    const scorer = context?.scorer;
    let filtered: Array<{ task: string; score: number }> | undefined;
    if (scorer) {
      const allTasks = [...tasks];
      const scores: number[] = yield* call(() => scorer.scoreEntailmentBatch(tasks));
      const surviving: string[] = [];
      const rejected: Array<{ task: string; score: number }> = [];
      for (let i = 0; i < tasks.length; i++) {
        if (scorer.shouldProceed(scores[i])) {
          surviving.push(tasks[i]);
        } else {
          rejected.push({ task: tasks[i], score: scores[i] });
        }
      }
      if (rejected.length > 0) filtered = rejected;

      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'entailment:delegate',
        tool: this.name,
        tasks: allTasks.map((text, i) => ({
          text: text.slice(0, 200),
          score: scores[i],
          kept: scorer.shouldProceed(scores[i]),
        })),
      });

      if (surviving.length === 0) {
        return { filtered, error: 'All proposed tasks drifted from the original query.' };
      }
      tasks = surviving;
    }

    const opts = this._spawnOpts;
    const toolkit = this._toolkit;
    const scope = traceScope(tw, null, `delegate:${this.name}`, { taskCount: tasks.length, filtered: filtered?.length ?? 0 });

    // Scorer propagation: same immutable scorer reaches all descendant pools
    const pool = yield* withSharedRoot(
      { systemPrompt: opts.systemPrompt, tools: toolkit.toolsJson, parent: context?.branch },
      function* (root) {
        return yield* useAgentPool({
          tasks: tasks.map((t) => ({
            systemPrompt: opts.systemPrompt,
            content: t,
            tools: toolkit.toolsJson,
            parent: root,
          })),
          tools: toolkit.toolMap,
          terminalTool: opts.terminalTool?.name,
          pruneOnReport: opts.pruneOnReport ?? true,
          maxTurns: opts.maxTurns,
          trace: opts.trace,
          pressure: opts.pressure,
          extractionPrompt: opts.extractionPrompt,
          policy: opts.policy,
          scorer: context?.scorer,
        });
      },
    );

    const result = {
      results: pool.agents.map((a) => a.result).filter(Boolean),
      nestedResults: pool.agents.flatMap((a) => a.nestedResults ?? []),
      agentCount: pool.agents.length,
      totalTokens: pool.totalTokens,
      totalToolCalls: pool.totalToolCalls,
      ...(filtered ? { filtered } : {}),
    };
    scope.close();
    return result;
  }
}

// ── spawnAgents ──────────────────────────────────────────────

/**
 * Spawn parallel agents with tools, optionally self-referential.
 *
 * Creates a shared root, forks one agent per task, runs the four-phase
 * tick loop, and returns results. When `recursive` is enabled, a
 * delegate tool is added to the toolkit that calls `spawnAgents()`
 * again — enabling agents to delegate sub-tasks at arbitrary depth.
 *
 * This is the general-purpose orchestration primitive. The harness
 * controls the prompt, tools, recursion shape, and policy. Sources
 * just provide data access tools.
 *
 * @example Research harness
 * ```typescript
 * const result = yield* spawnAgents({
 *   tools: source.tools,
 *   systemPrompt: RESEARCH_PROMPT,
 *   tasks: questions,
 *   terminalTool: { name: 'report', tool: reportTool },
 *   recursive: { name: 'web_research', extractTasks: (a) => a.questions as string[] },
 * });
 * ```
 *
 * @category Agents
 */
export function* spawnAgents(opts: SpawnAgentsOpts): Operation<AgentPoolResult> {
  // Build the recursive delegate tool if enabled
  let delegateTool: DelegateTool | undefined;

  if (opts.recursive) {
    const rc: RecursiveOpts = typeof opts.recursive === 'object' ? opts.recursive : {};
    const name = rc.name ?? 'delegate';
    const description = rc.description ?? `Delegate sub-tasks to parallel agents. Each task gets its own agent.`;
    const argsSchema = rc.argsSchema ?? DEFAULT_ARGS_SCHEMA;
    const extractTasks = rc.extractTasks ?? ((args: Record<string, unknown>) => args.tasks as string[]);

    delegateTool = new DelegateTool(name, description, argsSchema, extractTasks, opts);
  }

  // Compose toolkit: data tools + terminal tool + optional delegate tool
  const allTools: Tool[] = [
    ...opts.tools,
    ...(opts.terminalTool ? [opts.terminalTool.tool] : []),
    ...(delegateTool ? [delegateTool] : []),
  ];
  const toolkit = createToolkit(allTools);

  // Wire circular reference: delegate tool needs the toolkit that contains it
  if (delegateTool) {
    delegateTool.setToolkit(toolkit);
  }

  // Run the pool
  return yield* withSharedRoot(
    { systemPrompt: opts.systemPrompt, tools: toolkit.toolsJson, parent: opts.parent },
    function* (root) {
      return yield* useAgentPool({
        tasks: opts.tasks.map((t) => ({
          systemPrompt: opts.systemPrompt,
          content: t,
          tools: toolkit.toolsJson,
          parent: root,
        })),
        tools: toolkit.toolMap,
        terminalTool: opts.terminalTool?.name,
        pruneOnReport: opts.pruneOnReport,
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        pressure: opts.pressure,
        extractionPrompt: opts.extractionPrompt,
        policy: opts.policy,
        scorer: opts.scorer,
      });
    },
  );
}
