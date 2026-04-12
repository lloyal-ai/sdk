import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { Session } from '@lloyal-labs/sdk';
import { Tool } from './Tool';
import type { AgentPoolResult } from './types';
import type { AgentPolicy } from './AgentPolicy';
import type { EntailmentScorer } from './source';
import { Events } from './context';
import { createToolkit } from './toolkit';
import { withSharedRoot } from './shared-root';
import { useAgentPool } from './agent-pool';

/** Task input for createAgentPool */
export interface PoolTaskSpec {
  /** User message content — the agent's specific sub-question or task */
  content: string;
  /** Per-task system prompt. Falls back to pool-level systemPrompt when absent. */
  systemPrompt?: string;
  /** PRNG seed for sampler diversity */
  seed?: number;
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

// ── createAgentPool ─────────────────────────────────────────

/**
 * Create a parallel agent pool with tools.
 *
 * Composes `withSharedRoot` + `createToolkit` + `useAgentPool` internally.
 * Drains the Subscription inside `withSharedRoot`'s body and forwards
 * events to the broadcast Channel. Returns `AgentPoolResult` with
 * branches pruned.
 *
 * @example Research harness
 * ```typescript
 * const pool = yield* createAgentPool({
 *   tools: [delegateTool, ...source.tools, reportTool],
 *   systemPrompt: RESEARCH_PROMPT,
 *   tasks: questions.map(q => ({ content: q })),
 *   terminalTool: 'report',
 * });
 * ```
 *
 * @category Agents
 */
export function* createAgentPool(opts: CreateAgentPoolOpts): Operation<AgentPoolResult> {
  const broadcast = yield* Events.expect();

  const toolkit = createToolkit(opts.tools ?? []);

  // Warm path priority: explicit parent > session trunk > cold
  const warmParent = opts.parent ?? opts.session?.trunk ?? undefined;

  return yield* withSharedRoot(
    { systemPrompt: opts.systemPrompt, tools: toolkit.toolsJson, parent: warmParent },
    function* (root) {
      const sub = yield* useAgentPool({
        tasks: opts.tasks.map((t) => ({
          systemPrompt: t.systemPrompt ?? opts.systemPrompt,
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
