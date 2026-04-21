import type { Operation } from 'effection';
import { call } from 'effection';
import {
  Tool,
  Trace,
  CallingAgent,
  agentPool,
  parallel,
  traceScope,
} from '@lloyal-labs/lloyal-agents';
import type {
  JsonSchema,
  ToolContext,
  CreateAgentPoolOpts,
  AgentPolicy,
  Agent,
} from '@lloyal-labs/lloyal-agents';

/**
 * Configuration for {@link DelegateTool}.
 *
 * @category Rig
 */
export interface DelegateToolOpts {
  /** Tool name agents see in their toolkit. @default "delegate" */
  name?: string;
  /** Tool description shown in the agent's tool schema. */
  description?: string;
  /** JSON schema for the tool's arguments. */
  argsSchema?: JsonSchema;
  /** Extract task strings from parsed tool arguments. */
  extractTasks?: (args: Record<string, unknown>) => string[];
  /** Pool options propagated to the inner agentPool call. Orchestrator is set
   *  by DelegateTool (one agent per extracted task, parallel). */
  poolOpts: Omit<CreateAgentPoolOpts, 'orchestrate'>;
  /** Factory for per-invocation policy. Called fresh each time the tool fires so time budgets start from delegation, not from pool setup. */
  createPolicy?: () => AgentPolicy;
}

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
 * Tool that calls agentPool() recursively.
 *
 * Agents can delegate sub-tasks to parallel sub-agents at arbitrary depth,
 * bounded by KV pressure. Sub-agents fork from the calling agent's branch
 * (Continuous Context) and inherit the full attention state.
 *
 * Includes entailment gating (filters drifted tasks) and echo detection
 * (rejects paraphrases of the calling agent's own task).
 *
 * @category Rig
 */
export class DelegateTool extends Tool<Record<string, unknown>> {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;

  private _poolOpts: Omit<CreateAgentPoolOpts, 'orchestrate'>;
  private _extractTasks: (args: Record<string, unknown>) => string[];
  private _createPolicy?: () => AgentPolicy;

  constructor(opts: DelegateToolOpts) {
    super();
    this.name = opts.name ?? 'delegate';
    this.description = opts.description ?? 'Delegate sub-tasks to parallel agents. Each task gets its own agent.';
    this.parameters = opts.argsSchema ?? DEFAULT_ARGS_SCHEMA;
    this._extractTasks = opts.extractTasks ?? ((args: Record<string, unknown>) => args.tasks as string[]);
    this._poolOpts = opts.poolOpts;
    this._createPolicy = opts.createPolicy;
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

      // Echo guard — only fires when the calling agent has a parent (depth 2+).
      // At depth 1 (first delegation from a harness-spawned agent), there's no relay
      // chain to detect — sub-questions are expected to be similar to the task they decompose.
      const echoThreshold = this._poolOpts.echoThreshold ?? 0.8;
      let callingAgent: Agent | undefined;
      try { callingAgent = yield* CallingAgent.get(); } catch { /* top-level */ }

      if (callingAgent?.task && callingAgent.parent) {
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

    const pool = yield* agentPool({
      ...opts,
      ...(this._createPolicy ? { policy: this._createPolicy() } : {}),
      orchestrate: parallel(tasks.map(t => ({ systemPrompt: opts.systemPrompt, content: t }))),
      parent: context?.branch,
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
