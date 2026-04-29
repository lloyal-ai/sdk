import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { Session } from '@lloyal-labs/sdk';
import { Tool } from './Tool';
import type { AgentPoolResult } from './types';
import type { AgentPolicy } from './AgentPolicy';
import type { EntailmentScorer } from './source';
import type { Orchestrator } from './orchestrators';
import { Events } from './context';
import { createToolkit } from './toolkit';
import { withSharedRoot } from './shared-root';
import { useAgentPool } from './agent-pool';

// ── CreateAgentPool opts ────────────────────────────────────

/**
 * Options for {@link agentPool}.
 *
 * @category Agents
 */
export interface CreateAgentPoolOpts {
  /**
   * Orchestrator callback — declares the execution pattern (parallel, chain,
   * fanout, dag, or a custom inline generator). Drives task spawning,
   * waiting, and spine extension through {@link PoolContext}.
   */
  orchestrate: Orchestrator;
  /** Data access tools (array, createToolkit called internally). Optional — pool degenerates cleanly without tools. */
  tools?: Tool[];
  /** Terminal tool name — tool must be in the tools array. Pool intercepts and extracts result. */
  terminalTool?: string;
  /** Max tool-use turns per agent before hard cut. @default 100 */
  maxTurns?: number;
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
  /**
   * Whether the chat template delimits `<think>` blocks for this pool's agents.
   * See {@link AgentPoolOptions.enableThinking}.
   * @default false
   */
  enableThinking?: boolean;
  /**
   * Pool-shared system prompt. When set, the chat-format `[system + tools]`
   * header is prefilled onto the inner queryRoot once at setup; every agent
   * forking from queryRoot inherits the role+tools header via fork prefix-
   * sharing instead of re-emitting them in its own suffix. Use when every
   * spawn in the pool shares the same role (chain mode, single-role parallel/
   * fanout pools); leave unset for mixed-role workflows.
   *
   * Spawned agents may pass an empty string as their per-spec `systemPrompt`
   * to fully share the pool's system. A non-empty per-spec systemPrompt
   * layers as a second system message in the agent's KV (multi-system in
   * lineage — Qwen3 handles this; recovery has shipped on the same pattern).
   *
   * In shared mode, `extendRoot` writes onto the inner queryRoot rather than
   * the warm parent. Findings are visible to subsequent agents in the pool
   * and to nested `useAgent` calls within the same `withSharedRoot` scope,
   * but do NOT persist on the session trunk after the pool closes.
   */
  systemPrompt?: string;
}

// ── agentPool ───────────────────────────────────────────────

/**
 * Run a parallel agent pool with tools.
 *
 * Composes `withSharedRoot` + `createToolkit` + `useAgentPool` internally.
 * Drains the Subscription inside `withSharedRoot`'s body and forwards
 * events to the broadcast Channel. Returns `AgentPoolResult` with
 * branches pruned.
 *
 * @example Research harness
 * ```typescript
 * const pool = yield* agentPool({
 *   tools: [delegateTool, ...source.tools, reportTool],
 *   orchestrate: parallel(questions.map(q => ({ content: q, systemPrompt: RESEARCH_PROMPT }))),
 *   terminalTool: 'report',
 * });
 * ```
 *
 * @category Agents
 */
export function* agentPool(opts: CreateAgentPoolOpts): Operation<AgentPoolResult> {
  const broadcast = yield* Events.expect();

  const toolkit = createToolkit(opts.tools ?? []);

  // Warm path priority: explicit parent > session trunk > cold
  const warmParent = opts.parent ?? opts.session?.trunk ?? undefined;

  const sharedMode = opts.systemPrompt !== undefined;

  return yield* withSharedRoot(
    {
      parent: warmParent,
      systemPrompt: opts.systemPrompt,
      // Only emit toolsJson into the root header in shared mode; the rest
      // of the system uses the toolkit toolMap for actual dispatch.
      toolsJson: sharedMode ? toolkit.toolsJson : undefined,
      // Thread enableThinking so the root header chat-format and the
      // RootFmt FormatConfig (parser/grammar/triggers) match what the
      // per-agent suffixes get further down. Otherwise a caller passing
      // enableThinking:true gets divergent grammar between root + suffix.
      enableThinking: opts.enableThinking,
    },
    function* (root) {
      // SHARED mode (systemPrompt set): the inner `root` carries the
      // [system + tools] header and IS the spine. extendRoot writes onto
      // it, agents fork from it, nested useAgent calls fork from it. Inner
      // root is pruned at withSharedRoot exit; that's fine because pool
      // findings flow to the session via session.commitTurn (post-pool),
      // not via root mutation.
      //
      // NON-SHARED mode (existing behavior): on warm path, use the caller-
      // provided parent AS the logical spine so `ctx.extendRoot` mutations
      // persist across the pool's lifetime and are visible to sibling pools
      // that fork from the same parent. The inner `root` is just a
      // separator-prefilled fork of parent — its extensions would be
      // discarded at pool close, breaking the multi-task spine pattern
      // (research → synth over shared queryRoot). On cold path, the inner
      // root IS the spine.
      const spineRoot = sharedMode ? root : (warmParent ?? root);
      const sub = yield* useAgentPool({
        root: spineRoot,
        orchestrate: opts.orchestrate,
        toolsJson: toolkit.toolsJson,
        tools: toolkit.toolMap,
        terminalTool: opts.terminalTool,
        pruneOnReport: opts.pruneOnReport,
        maxTurns: opts.maxTurns,
        trace: opts.trace,
        policy: opts.policy,
        scorer: opts.scorer,
        enableThinking: opts.enableThinking,
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
