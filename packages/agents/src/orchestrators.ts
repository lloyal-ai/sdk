import { all, spawn } from 'effection';
import type { Operation, Task } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import type { Agent } from './Agent';

/**
 * Spec for spawning a single agent under a {@link PoolContext}.
 * `parent` defaults to `ctx.root`.
 *
 * @category Agents
 */
export interface SpawnSpec {
  /** User message content — the agent's task. */
  content: string;
  /** Per-agent system prompt. */
  systemPrompt: string;
  /** PRNG seed for sampler diversity. */
  seed?: number;
  /** Parent branch to fork from. Falls back to ctx.root. */
  parent?: Branch;
}

/**
 * Orchestrator-facing API surface exposed by {@link useAgentPool}.
 *
 * The orchestrator drives task spawning, waiting, and spine extension
 * through this object. The pool's tick loop runs concurrently and batches
 * decode across whatever agents are currently active.
 *
 * @category Agents
 */
export interface PoolContext {
  /** Shared root branch. Orchestrator-provided spawns fork from here by default. */
  readonly root: Branch;

  /** Fork an agent branch, prefill its suffix, transition to active. Tick loop picks it up. */
  spawn(spec: SpawnSpec): Operation<Agent>;

  /** Suspend until agent.status becomes 'idle' | 'disposed'. Returns agent for chaining. */
  waitFor(agent: Agent): Operation<Agent>;

  /**
   * Serialize a user+assistant turn and prefill it into root, advancing root.position.
   * No-op (returns 0) when assistantContent is empty.
   */
  extendRoot(userContent: string, assistantContent: string): Operation<number>;

  /** Whether another spawn with this suffix size would fit under current pressure. */
  canFit(estimatedSuffixTokens: number): boolean;
}

/**
 * An orchestrator is a generator that drives a pool via {@link PoolContext}.
 * Returned by the factory functions in this module.
 *
 * @category Agents
 */
export type Orchestrator = (ctx: PoolContext) => Operation<void>;

// ── Factories ──────────────────────────────────────────────────

/**
 * Parallel orchestrator — spawn all tasks upfront, wait for all to complete.
 * This is the default shape that `useAgentPool` used to provide implicitly.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   tools: [...],
 *   orchestrate: parallel(questions.map(q => ({ content: q, systemPrompt: RESEARCH_PROMPT }))),
 * });
 * ```
 *
 * @category Agents
 */
export const parallel = (tasks: SpawnSpec[]): Orchestrator =>
  function* (ctx) {
    const agents = yield* all(tasks.map(t => ctx.spawn({ ...t, parent: t.parent ?? ctx.root })));
    yield* all(agents.map(a => ctx.waitFor(a)));
  };

/**
 * One step of a {@link chain} orchestrator. Declares the task, optional user
 * content for spine extension after the task reports, and optional observability
 * hooks that fire before the spawn and after the spine extension.
 *
 * The hooks let harnesses emit streaming events (per-task progress, completion
 * telemetry) without dropping down to an inline orchestrator — the factory
 * stays declarative while the hook bodies stay co-located with the step they
 * instrument.
 *
 * @category Agents
 */
export interface ChainStep {
  task: SpawnSpec;
  /** User content recorded on the spine (e.g., "Research task: ..."). Omit to skip extension. */
  userContent?: string;
  /** Fires BEFORE `ctx.spawn` for this step. Use for "task starting" events. */
  beforeSpawn?: () => Operation<void>;
  /**
   * Fires AFTER `ctx.extendRoot` for this step (or immediately after waitFor
   * if no extension happened). Receives the number of tokens added to the
   * spine (0 when no extension) and the root's position after any extension.
   * Use for "task done" events with spine telemetry.
   */
  afterExtend?: (delta: number, position: number) => Operation<void>;
}

/**
 * Chain orchestrator — sequential execution. Each step may extend the shared
 * root with its findings before the next step forks from the extended position.
 *
 * The second argument maps each item to a ChainStep, so callers can compute
 * per-task prompts and spine labels from their own data model without
 * coupling the factory to a particular task type.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   tools: [...],
 *   parent: queryRoot,
 *   orchestrate: chain(researchTasks, (task, i) => ({
 *     task: { content: taskToContent(task), systemPrompt: renderWorker({ taskIndex: i }) },
 *     userContent: `Research task: ${task.description}`,
 *   })),
 * });
 * ```
 *
 * @category Agents
 */
export const chain = <T>(
  items: T[],
  toStep: (item: T, index: number) => ChainStep,
): Orchestrator =>
  function* (ctx) {
    for (const [i, item] of items.entries()) {
      const step = toStep(item, i);
      if (step.beforeSpawn) yield* step.beforeSpawn();
      const agent = yield* ctx.waitFor(
        yield* ctx.spawn({ ...step.task, parent: step.task.parent ?? ctx.root }),
      );
      const delta = agent.result && step.userContent
        ? yield* ctx.extendRoot(step.userContent, agent.result)
        : 0;
      if (step.afterExtend) yield* step.afterExtend(delta, ctx.root.position);
    }
  };

/**
 * Fanout orchestrator — landscape task first (optionally extending the spine),
 * then N independent domain tasks in parallel. Domain tasks fork from the
 * post-landscape root and do NOT see each other's findings.
 *
 * The canonical shape for multi-domain queries: one landscape survey that
 * loads vocabulary into the spine, then one task per independent domain.
 *
 * @example
 * ```ts
 * yield* agentPool({
 *   orchestrate: fanout(
 *     { task: { content: landscapeQuery, systemPrompt: WORKER }, userContent: 'Landscape survey' },
 *     domainQueries.map(q => ({ content: q, systemPrompt: WORKER })),
 *   ),
 * });
 * ```
 *
 * @category Agents
 */
export const fanout = (landscape: ChainStep, domains: SpawnSpec[]): Orchestrator =>
  function* (ctx) {
    const l = yield* ctx.waitFor(
      yield* ctx.spawn({ ...landscape.task, parent: landscape.task.parent ?? ctx.root }),
    );
    if (l.result && landscape.userContent) {
      yield* ctx.extendRoot(landscape.userContent, l.result);
    }

    const agents = yield* all(
      domains.map(d => ctx.spawn({ ...d, parent: d.parent ?? ctx.root })),
    );
    yield* all(agents.map(a => ctx.waitFor(a)));
  };

/**
 * A node in a {@link dag} orchestrator. Dependencies are referenced by id.
 *
 * @category Agents
 */
export interface DAGNode {
  id: string;
  task: SpawnSpec;
  /** Ids of nodes that must complete before this node spawns. */
  dependsOn?: string[];
  /** User content for spine extension when this node reports. Omit to skip extension. */
  userContent?: string;
}

/**
 * DAG orchestrator — lazy spawn on dependency resolution. Independent nodes
 * run in parallel; dependent nodes wait until their dependencies complete
 * (and their findings extend the spine) before forking.
 *
 * Subsumes the design in `docs/dag-pool.md` — DAG is an orchestration
 * pattern expressed on top of the general primitive, not a pool internals
 * change.
 *
 * @category Agents
 */
export const dag = (nodes: DAGNode[]): Orchestrator => {
  validateDAG(nodes);
  return function* (ctx) {
    // Each node runs as a child Task. Dependencies are expressed by
    // awaiting the dep's Task (`yield* depTask`) — Task<T> extends
    // Future<T> extends Operation<T>, so this is the canonical Effection
    // cross-task rendezvous (see frontside.com/effection/api/v4/Task).
    //
    // Why this beats the older recursive-spawnNode-with-Sets approach:
    //   - No mutable bookkeeping. The "node N is done" signal IS the
    //     Task itself; the runtime tracks lifetimes for free.
    //   - No race window for double-spawn. Each node spawns exactly
    //     once, by definition (one entry per `tasks.set`).
    //   - Failure propagates through the dependency edges automatically:
    //     if node A throws, every task awaiting A's Task receives the
    //     same error, and structured concurrency halts the rest.
    const tasks = new Map<string, Task<void>>();

    function* runNode(n: DAGNode): Operation<void> {
      // Gate: wait for every declared dep's task to complete. The map is
      // fully populated before any node body runs (spawned tasks don't
      // execute until the parent yields, and the spawn loop below is
      // synchronous between iterations).
      for (const depId of n.dependsOn ?? []) {
        yield* tasks.get(depId)!;
      }
      const agent = yield* ctx.waitFor(
        yield* ctx.spawn({ ...n.task, parent: n.task.parent ?? ctx.root }),
      );
      if (agent.result && n.userContent) {
        yield* ctx.extendRoot(n.userContent, agent.result);
      }
    }

    for (const n of nodes) {
      tasks.set(n.id, yield* spawn(() => runNode(n)));
    }
    // Await every task. Roots run first (no deps to await); descendants
    // unblock as their deps complete. Any throw inside a node propagates
    // here and halts the rest via structured concurrency.
    for (const t of tasks.values()) yield* t;
  };
};

function validateDAG(nodes: DAGNode[]): void {
  const ids = new Set(nodes.map(n => n.id));
  const duplicates = nodes.filter((n, i) => nodes.findIndex(m => m.id === n.id) !== i);
  if (duplicates.length > 0) {
    throw new Error(`dag: duplicate node ids: ${duplicates.map(n => n.id).join(', ')}`);
  }
  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!ids.has(dep)) throw new Error(`dag: node '${n.id}' depends on unknown node '${dep}'`);
    }
  }
  // Cycle detection via DFS
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const byId = new Map(nodes.map(n => [n.id, n]));
  function visit(id: string, path: string[]): void {
    if (visited.has(id)) return;
    if (visiting.has(id)) throw new Error(`dag: cycle detected: ${[...path, id].join(' -> ')}`);
    visiting.add(id);
    const node = byId.get(id);
    for (const dep of node?.dependsOn ?? []) visit(dep, [...path, id]);
    visiting.delete(id);
    visited.add(id);
  }
  for (const n of nodes) visit(n.id, []);
}
