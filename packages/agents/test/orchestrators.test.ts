/**
 * Unit tests for the orchestrator combinators.
 *
 * The orchestrators (parallel/chain/fanout/dag) are pure generator
 * factories — they take node specs and return a generator that drives
 * `ctx.spawn` / `ctx.waitFor` / `ctx.extendRoot`. We can test them
 * against a mock PoolContext that records calls without spinning up the
 * real pool.
 *
 * Regression coverage:
 *   - `dag()` must not double-spawn sibling roots when one finishes
 *     before another. (Bug found via examples/compare/ producing 9
 *     agents for a 6-node DAG.)
 */

import { describe, it, expect } from 'vitest';
import { run, sleep, call } from 'effection';
import type { Operation } from 'effection';
import type { Branch } from '@lloyal-labs/sdk';
import { dag, type DAGNode, type SpawnSpec } from '../src/orchestrators';
import type { PoolContext } from '../src/orchestrators';
import type { Agent } from '../src/Agent';

interface MockAgent {
  id: number;
  result: string | null;
  /** Resolves the agent's waitFor; tests advance time to control completion order. */
  finish: () => void;
}

interface MockHarness {
  ctx: PoolContext;
  spawnedIds: string[];
  /** Map from a node's task content (used as identity here) to the mock agent. */
  agents: Map<string, MockAgent>;
}

/**
 * Build a mock PoolContext that resolves `waitFor` after a configurable
 * delay per agent. Records every `ctx.spawn` call so tests can assert
 * how many times each node id was spawned.
 *
 * Node identity is carried through `task.content` so tests don't need
 * a side channel — the orchestrator passes the content untouched.
 */
function createMockHarness(delays: Map<string, number>): MockHarness {
  let nextAgentId = 1;
  const spawnedIds: string[] = [];
  const agents = new Map<string, MockAgent>();
  const root = {} as Branch;

  const ctx: PoolContext = {
    root,

    *spawn(spec: SpawnSpec): Operation<Agent> {
      const id = nextAgentId++;
      const content = spec.content;
      spawnedIds.push(content);

      const delay = delays.get(content) ?? 10;
      let resolve: () => void = () => {};
      const finishedPromise = new Promise<void>((r) => { resolve = r; });

      const mock: MockAgent = {
        id,
        result: `result of ${content}`,
        finish: resolve,
      };
      agents.set(content, mock);

      // Auto-finish after delay so tests can interleave completions
      // simply by setting different delays.
      setTimeout(resolve, delay);

      // Stash the finished promise on the agent for waitFor to await.
      (mock as MockAgent & { _done: Promise<void> })._done = finishedPromise;

      return mock as unknown as Agent;
    },

    *waitFor(agent: Agent): Operation<Agent> {
      const ma = agent as unknown as MockAgent & { _done: Promise<void> };
      yield* call(() => ma._done);
      return agent;
    },

    *extendRoot(_userContent: string, _assistantContent: string): Operation<number> {
      return 0;
    },

    canFit(_estimatedSuffixTokens: number): boolean {
      return true;
    },
  };

  return { ctx, spawnedIds, agents };
}

function node(id: string, dependsOn: string[] = []): DAGNode {
  return {
    id,
    dependsOn: dependsOn.length ? dependsOn : undefined,
    task: {
      content: id, // identity carried as content
      systemPrompt: `system for ${id}`,
    },
    userContent: `findings: ${id}`,
  };
}

describe('dag orchestrator', () => {
  it('spawns each declared node exactly once even when sibling roots finish at different times', async () => {
    // Compare-style topology: 2 roots → 3 fan-in/fan-out → 1 sink.
    // Make `web` finish faster than `corp` so the recursive newlyReady
    // filter has the chance to misclassify `corp` as "newly ready"
    // when web completes.
    const delays = new Map([
      ['web', 5],
      ['corp', 30],
      ['c1', 5],
      ['c2', 5],
      ['c3', 5],
      ['synth', 5],
    ]);
    const { ctx, spawnedIds } = createMockHarness(delays);

    const nodes: DAGNode[] = [
      node('web'),
      node('corp'),
      node('c1', ['web', 'corp']),
      node('c2', ['web', 'corp']),
      node('c3', ['web', 'corp']),
      node('synth', ['c1', 'c2', 'c3']),
    ];

    await run(function* () {
      yield* dag(nodes)(ctx);
      yield* sleep(0);
    });

    // Each node should have spawned exactly once. Pre-fix the count was 9.
    expect(spawnedIds.sort()).toEqual(['c1', 'c2', 'c3', 'corp', 'synth', 'web']);
    expect(spawnedIds.length).toBe(6);
  });

  it('no double-spawn when many roots resolve simultaneously', async () => {
    // 4 sibling roots, all finishing at the same delay — stress the race
    // window where multiple completions try to recompute newlyReady.
    const delays = new Map([
      ['a', 10],
      ['b', 10],
      ['c', 10],
      ['d', 10],
      ['sink', 5],
    ]);
    const { ctx, spawnedIds } = createMockHarness(delays);

    const nodes: DAGNode[] = [
      node('a'),
      node('b'),
      node('c'),
      node('d'),
      node('sink', ['a', 'b', 'c', 'd']),
    ];

    await run(function* () {
      yield* dag(nodes)(ctx);
      yield* sleep(0);
    });

    expect(spawnedIds.sort()).toEqual(['a', 'b', 'c', 'd', 'sink']);
  });

  it('chain-shaped DAG runs each node once', async () => {
    const delays = new Map([['a', 5], ['b', 5], ['c', 5]]);
    const { ctx, spawnedIds } = createMockHarness(delays);

    const nodes: DAGNode[] = [
      node('a'),
      node('b', ['a']),
      node('c', ['b']),
    ];

    await run(function* () {
      yield* dag(nodes)(ctx);
      yield* sleep(0);
    });

    expect(spawnedIds).toEqual(['a', 'b', 'c']);
  });

  it('a failing node halts dependent siblings via structured concurrency', async () => {
    // Topology: failer → consumer.  consumer awaits failer's Task; when
    // failer throws, consumer's `yield* tasks.get(failer)` re-raises and
    // structured-concurrency halts the rest of the DAG. The orchestrator
    // itself rejects with the original error.
    const delays = new Map([['failer', 5], ['consumer', 5]]);
    const { ctx } = createMockHarness(delays);
    // Override spawn to make 'failer' throw during waitFor.
    const origSpawn = ctx.spawn.bind(ctx);
    ctx.spawn = function* spawn(spec: SpawnSpec) {
      const agent = yield* origSpawn(spec);
      if (spec.content === 'failer') {
        // Tag the agent so the mock waitFor below knows to throw.
        (agent as unknown as { _shouldFail: boolean })._shouldFail = true;
      }
      return agent;
    };
    const origWaitFor = ctx.waitFor.bind(ctx);
    ctx.waitFor = function* waitFor(agent) {
      const result = yield* origWaitFor(agent);
      if ((agent as unknown as { _shouldFail?: boolean })._shouldFail) {
        throw new Error('failer node blew up');
      }
      return result;
    };

    const nodes: DAGNode[] = [
      node('failer'),
      node('consumer', ['failer']),
    ];

    // Effection structured concurrency surfaces a spawned-task failure
    // through the scope itself: `run()` rejects with the original error,
    // and any sibling tasks that hadn't completed get halted.
    let caught: Error | null = null;
    try {
      await run(function* () {
        yield* dag(nodes)(ctx);
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).not.toBeNull();
    expect(caught!.message).toBe('failer node blew up');
  });
});
