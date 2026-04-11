import { resource, ensure, call, scoped } from 'effection';
import type { Operation } from 'effection';
import { Branch } from '@lloyal-labs/sdk';
import type { Session, SessionContext } from '@lloyal-labs/sdk';
import { Agent } from './Agent';
import { Ctx, Events, Trace } from './context';
import { useAgentPool } from './agent-pool';
import { createToolkit } from './toolkit';
import { traceScope } from './trace-scope';
import type { Tool } from './Tool';
import type { AgentPolicy } from './AgentPolicy';
import type { JsonSchema, SamplingParams, AgentEvent } from './types';

/**
 * Options for {@link useAgent} and {@link createAgent}.
 *
 * @category Agents
 */
export interface UseAgentOpts {
  /** System prompt defining the agent's role and behavior. */
  systemPrompt: string;
  /** User message content — the agent's task. */
  task: string;
  /** Tools available to the agent. Optional — pool degenerates cleanly without tools. */
  tools?: Tool[];
  /** Terminal tool name — tool must be in the tools array. */
  terminalTool?: string;
  /** Max tool-use turns before hard cut. @default 100 */
  maxTurns?: number;
  /** JSON Schema for eager grammar constraint (deferred: Zod support). */
  schema?: JsonSchema;
  /** Sampling parameters. */
  params?: SamplingParams;
  /** Explicit parent branch for warm path (Continuous Context). */
  parent?: Branch;
  /** Session for warm path via trunk. */
  session?: Session;
  /** Custom agent policy. */
  policy?: AgentPolicy;
  /** Enable structured trace events. */
  trace?: boolean;
}

/**
 * Single-agent resource — delegates to {@link useAgentPool} N=1.
 *
 * One path. No conditional. Tools optional — `useAgentPool` with no tools
 * degenerates cleanly (tick loop: produce → commit → stop, no dispatch).
 *
 * Provides a completed Agent with branches alive. The resource keeps the
 * root and agent branch alive until the caller's scope exits — caller can
 * fork from the Agent's branch for verification or follow-up.
 *
 * Root managed via `ensure()` (not `withSharedRoot`) because the resource
 * lifetime requires the root alive until the caller's scope exits.
 *
 * Events stream passively to the broadcast Channel during the inline drain.
 *
 * @param opts - Agent configuration
 * @returns Agent with result populated, branches alive
 *
 * @example Single agent with tools
 * ```typescript
 * const agent = yield* useAgent({
 *   systemPrompt: "You are a research assistant.",
 *   task: "Find information about X",
 *   tools: [searchTool, reportTool],
 *   terminalTool: 'report',
 * });
 * // agent.result — findings
 * // agent.branch — alive, can fork from
 * ```
 *
 * @category Agents
 */
export function useAgent(opts: UseAgentOpts): Operation<Agent> {
  return resource(function*(provide) {
    const ctx: SessionContext = yield* Ctx.expect();
    const broadcast = yield* Events.expect();
    const tw = yield* Trace.expect();
    const toolkit = createToolkit(opts.tools ?? []);
    const warmParent = opts.parent ?? opts.session?.trunk ?? undefined;

    const scope = traceScope(tw, null, 'useAgent', {
      hasTools: !!(opts.tools?.length),
      hasParent: !!warmParent,
    });

    // Format shared prefix
    const messages = [{ role: 'system', content: opts.systemPrompt }];
    const fmtOpts: Record<string, unknown> = { addGenerationPrompt: false, enableThinking: false };
    if (opts.tools?.length) fmtOpts.tools = toolkit.toolsJson;
    const fmt = ctx.formatChatSync(JSON.stringify(messages), fmtOpts);
    const sharedTokens = ctx.tokenizeSync(fmt.prompt);

    // Create root — ensure() for resource lifetime (not withSharedRoot's try/finally)
    const root = warmParent
      ? warmParent.forkSync()
      : Branch.create(ctx, 0, opts.params ?? { temperature: 0.5 });
    yield* ensure(() => { if (!root.disposed) root.pruneSubtreeSync(); });

    const prefillTokens = warmParent ? ctx.getTurnSeparator() : sharedTokens;
    yield* call(() => root.prefill(prefillTokens));

    // Eager grammar from schema — set on root before fork.
    // Fork inherits grammar state. formatChatSync returns no grammar for
    // no-tools case, so applyLazyGrammar is a no-op and the inherited
    // eager grammar persists on the forked agent branch.
    if (opts.schema) {
      const grammar = yield* call(() => ctx.jsonSchemaToGrammar(JSON.stringify(opts.schema)));
      root.setGrammar(grammar);
    }

    // Delegate to useAgentPool N=1
    const hasTools = !!(opts.tools?.length);
    const sub = yield* useAgentPool({
      tasks: [{
        systemPrompt: opts.systemPrompt,
        content: opts.task,
        tools: hasTools ? toolkit.toolsJson : undefined,
        parent: root,
      }],
      tools: toolkit.toolMap,
      terminalTool: opts.terminalTool,
      maxTurns: opts.maxTurns,
      policy: opts.policy,
      trace: opts.trace,
    });

    // Drain Subscription inline — forward to broadcast
    let next = yield* sub.next();
    while (!next.done) {
      yield* broadcast.send(next.value as AgentEvent);
      next = yield* sub.next();
    }
    const pool = next.value;

    scope.close();

    yield* provide(pool.agents[0].agent);
    // Resource stays alive — branch alive for caller to fork from
    // ensure() prunes root on scope exit
  });
}

/**
 * Single-agent scoped operation — wraps {@link useAgent} in `scoped()`.
 *
 * Returns completed Agent with result populated. Branches pruned on scope exit.
 * This is the harness-level API for single-agent steps (plan, eval, bridge).
 *
 * @param opts - Agent configuration (same as {@link UseAgentOpts})
 * @returns Completed Agent with `.result`, `.rawOutput`, `.tokenCount`
 *
 * @example Plan step
 * ```typescript
 * const agent = yield* createAgent({
 *   systemPrompt: PLAN.system,
 *   task: query,
 *   schema: planSchema,
 * });
 * const plan = JSON.parse(agent.rawOutput);
 * ```
 *
 * @category Agents
 */
export function* createAgent(opts: UseAgentOpts): Operation<Agent> {
  return yield* scoped(function*() {
    return yield* useAgent(opts);
  });
}
