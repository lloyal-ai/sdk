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

/** Task input for orchestrator factories (re-exported from orchestrators). */
export type { SpawnSpec as PoolTaskSpec } from './orchestrators';

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
  /** System prompt for all agents. */
  systemPrompt: string;
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
 *   systemPrompt: RESEARCH_PROMPT,
 *   tasks: questions.map(q => ({ content: q })),
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

  return yield* withSharedRoot(
    { systemPrompt: opts.systemPrompt, tools: toolkit.toolsJson, parent: warmParent },
    function* (root) {
      // On warm path, use the caller-provided parent AS the logical spine so
      // `ctx.extendRoot` mutations persist across the pool's lifetime and are
      // visible to sibling pools that fork from the same parent. The inner
      // `root` produced by withSharedRoot is just a separator-prefilled fork
      // of parent — its extensions would be discarded at pool close, breaking
      // the multi-task spine pattern (research → synth over shared queryRoot).
      // On cold path (no parent), the inner root IS the spine.
      const spineRoot = warmParent ?? root;
      const sub = yield* useAgentPool({
        root: spineRoot,
        orchestrate: opts.orchestrate,
        systemPrompt: opts.systemPrompt,
        toolsJson: toolkit.toolsJson,
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
