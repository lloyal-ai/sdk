import type { Operation } from 'effection';
import { call } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { Session } from '@lloyal-labs/sdk';
import { Tool } from './Tool';
import type { JsonSchema, ToolContext } from './types';
import type { AgentPoolResult } from './types';

/** Task input for createAgentPool — systemPrompt applied from pool opts */
export interface PoolTaskSpec {
  /** User message content — the agent's specific sub-question or task */
  content: string;
  /** PRNG seed for sampler diversity */
  seed?: number;
}
import type { AgentPolicy } from './AgentPolicy';
import type { EntailmentScorer } from './source';
import type { Agent } from './Agent';
import { Trace, Events, CallingAgent } from './context';
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

// ── CreateAgentPool opts ────────────────────────────────────

/**
 * Options for {@link createAgentPool}.
 *
 * @category Agents
 */
export interface CreateAgentPoolOpts {
  /** Agent task specifications — one per concurrent agent. systemPrompt applied from pool opts. */
  tasks: PoolTaskSpec[];
  /** Data access tools (array, createToolkit called internally). Optional — pool degenerates cleanly without tools. */
  tools?: Tool[];
  /** System prompt for all agents. */
  systemPrompt: string;
  /** Terminal tool name — tool must be in the tools array. Pool intercepts and extracts result. */
  terminalTool?: string;
  /** Max tool-use turns per agent before hard cut. @default 100 */
  maxTurns?: number;
  /**
   * Enable self-referential recursion. When truthy, a wrapper tool is
   * added to the toolkit that calls `createAgentPool()` recursively.
   */
  recursive?: boolean | RecursiveOpts;
  /** Prune agent branches immediately on report, freeing KV mid-pool. */
  pruneOnReport?: boolean;
  /** Custom agent policy. @default DefaultAgentPolicy */
  policy?: AgentPolicy;
  /** Enable structured trace events. */
  trace?: boolean;
  /**
   * Explicit parent branch for warm path (Continuous Context).
   * Used by DelegateTool to fork from the calling agent's branch.
   * Sub-agents inherit full attention state.
   */
  parent?: Branch;
  /**
   * Session for warm path via trunk. When session.trunk exists,
   * the shared root forks from it. When absent, cold start at position 0.
   */
  session?: Session;
  /** Entailment scorer for semantic coherence across recursive depths. */
  scorer?: EntailmentScorer;
  /** Echo detection threshold. @default 0.8 */
  echoThreshold?: number;
  /** Check ancestor tasks for echo. @default false */
  checkAncestorEcho?: boolean;
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
 * Internal tool that calls createAgentPool() recursively.
 * Created by createAgentPool() when `recursive` is enabled.
 */
class DelegateTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;

  private _poolOpts: CreateAgentPoolOpts;
  private _extractTasks: (args: Record<string, unknown>) => string[];
  private _toolkit: Toolkit | null = null;

  constructor(
    name: string,
    description: string,
    argsSchema: JsonSchema,
    extractTasks: (args: Record<string, unknown>) => string[],
    poolOpts: CreateAgentPoolOpts,
  ) {
    super();
    this.name = name;
    this.description = description;
    this.parameters = argsSchema;
    this._extractTasks = extractTasks;
    this._poolOpts = poolOpts;
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

      let _diagAgent: Agent | undefined;
      try { _diagAgent = yield* CallingAgent.get(); } catch { /* top-level */ }

      tw.write({
        traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
        type: 'entailment:delegate',
        tool: this.name,
        callingAgentId: _diagAgent?.id,
        callingAgentTaskLength: _diagAgent?.task?.length,
        callingAgentTask: _diagAgent?.task?.slice(0, 200),
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

      // Echo guard
      const echoThreshold = this._poolOpts.echoThreshold ?? 0.8;
      let callingAgent: Agent | undefined;
      try { callingAgent = yield* CallingAgent.get(); } catch { /* top-level */ }

      if (callingAgent?.task) {
        const echoScores: number[] = yield* call(() =>
          scorer.scoreSimilarityBatch(callingAgent!.task, tasks),
        );
        const minEchoScore = Math.min(...echoScores);
        const echoRejected = minEchoScore > echoThreshold;

        tw.write({
          traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
          type: 'entailment:delegate:echo',
          tool: this.name,
          agentTask: callingAgent.task.slice(0, 200),
          tasks: tasks.map((text, i) => ({ text: text.slice(0, 200), echoScore: echoScores[i] })),
          threshold: echoThreshold,
          rejected: echoRejected,
        });

        if (echoRejected) {
          return {
            filtered,
            echoRejected: true,
            error: 'Your sub-questions are too similar to your own task. You have already searched and read content on this topic. Call report() with what you found, including what you checked but could not find.',
          };
        }

        if (this._poolOpts.checkAncestorEcho) {
          const ancestorTasks = callingAgent.walkAncestors(a => a.task ? [a.task] : [])
            .filter(t => t !== callingAgent!.task);
          for (const ancestorTask of ancestorTasks) {
            const ancestorScores: number[] = yield* call(() =>
              scorer.scoreSimilarityBatch(ancestorTask, tasks),
            );
            if (Math.min(...ancestorScores) > echoThreshold) {
              tw.write({
                traceId: tw.nextId(), parentTraceId: null, ts: performance.now(),
                type: 'entailment:delegate:echo',
                tool: this.name,
                agentTask: ancestorTask.slice(0, 200),
                tasks: tasks.map((text, i) => ({ text: text.slice(0, 200), echoScore: ancestorScores[i] })),
                threshold: echoThreshold,
                rejected: true,
              });
              return {
                filtered,
                echoRejected: true,
                error: 'Your sub-questions echo an ancestor task. Report what you found instead of re-delegating.',
              };
            }
          }
        }
      }
    }

    const opts = this._poolOpts;
    const scope = traceScope(tw, null, `delegate:${this.name}`, { taskCount: tasks.length, filtered: filtered?.length ?? 0 });

    // Recursive call — createAgentPool handles shared root, toolkit, broadcast forwarding
    const pool = yield* createAgentPool({
      ...opts,
      tasks: tasks.map(t => ({ systemPrompt: opts.systemPrompt, content: t })),
      parent: context?.branch, // Continuous Context — sub-agents inherit calling agent's KV state
      pruneOnReport: opts.pruneOnReport ?? true,
      scorer: context?.scorer,
    });

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

// ── createAgentPool ─────────────────────────────────────────

/**
 * Create a parallel agent pool with tools, optionally self-referential.
 *
 * Composes `withSharedRoot` + `createToolkit` + `useAgentPool` internally.
 * Drains the Subscription inside `withSharedRoot`'s body and forwards
 * events to the broadcast Channel. Returns `AgentPoolResult` with
 * branches pruned.
 *
 * When `recursive` is enabled, a delegate tool is added that calls
 * `createAgentPool()` again — enabling agents to delegate at arbitrary
 * depth, bounded by KV pressure.
 *
 * @example Research harness
 * ```typescript
 * const pool = yield* createAgentPool({
 *   tools: [...source.tools, reportTool],
 *   systemPrompt: RESEARCH_PROMPT,
 *   tasks: questions.map(q => ({ content: q })),
 *   terminalTool: 'report',
 *   recursive: { name: 'web_research', extractTasks: (a) => a.questions as string[] },
 * });
 * ```
 *
 * @category Agents
 */
export function* createAgentPool(opts: CreateAgentPoolOpts): Operation<AgentPoolResult> {
  const broadcast = yield* Events.expect();

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

  // Compose toolkit: data tools + optional delegate tool
  const allTools: Tool[] = [
    ...(opts.tools ?? []),
    ...(delegateTool ? [delegateTool] : []),
  ];
  const toolkit = createToolkit(allTools);

  // Wire circular reference: delegate tool needs the toolkit that contains it
  if (delegateTool) {
    delegateTool.setToolkit(toolkit);
  }

  // Warm path priority: explicit parent > session trunk > cold
  const warmParent = opts.parent ?? opts.session?.trunk ?? undefined;

  return yield* withSharedRoot(
    { systemPrompt: opts.systemPrompt, tools: toolkit.toolsJson, parent: warmParent },
    function* (root) {
      const sub = yield* useAgentPool({
        tasks: opts.tasks.map((t) => ({
          systemPrompt: opts.systemPrompt,
          content: t.content,
          tools: toolkit.toolsJson,
          parent: root,
          seed: t.seed,
        })),
        tools: toolkit.toolMap,
        terminalTool: opts.terminalTool,
        pruneOnReport: opts.pruneOnReport,
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        policy: opts.policy,
        scorer: opts.scorer,
      });

      // Drain Subscription inside body — before withSharedRoot's finally fires
      let next = yield* sub.next();
      while (!next.done) {
        yield* broadcast.send(next.value);
        next = yield* sub.next();
      }
      return next.value;
    },
  );
}
