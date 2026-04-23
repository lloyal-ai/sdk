/**
 * Scenario: concurrent extendRoot calls are serialized through the tick loop.
 *
 * Before the fix, `PoolContext.extendRoot` issued `store.prefill` directly
 * from the orchestrator's fiber — racing with the tick loop's own native
 * work. Chain mode (serial spawn→wait→extend) never exercised the race,
 * but flat mode (dag with no deps) drove N concurrent fibers each calling
 * extendRoot when their agent completed. Two fibers could hit
 * `store.prefill` at the same time, violating I1 single-fiber discipline.
 *
 * The fix queues extend requests into `pendingExtends` and drains them in
 * the tick loop's SPAWN+EXTEND phase via an Effection `action()`
 * rendezvous. This scenario locks that behavior:
 *
 *   - Multiple concurrent extendRoot calls never produce overlapping
 *     native calls (I1 invariant).
 *   - Each extendRoot completes (emits a `spine:extend` trace event).
 *   - Extend tokens land on the root branch (root.position advances).
 */
import { describe, it, expect } from 'vitest';
import { all } from 'effection';
import type { Operation } from 'effection';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import type { PoolContext } from '../../../src/orchestrators';
import { runPool, STOP } from '../harness';
import { I1_nativeStoreSingleFiber } from '../predicates';

describe('scenario: concurrent extendRoot has no native-call overlap', () => {
  const minimalPolicy: AgentPolicy = {
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      return { type: 'idle', reason: 'free_text_stop' };
    },
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    shouldExit: () => false,
    onRecovery: () => ({ type: 'skip' }),
  };

  it('multiple concurrent extendRoot calls do not overlap at the native layer', async () => {
    // Custom orchestrator: spawn 3 agents concurrently, wait for all,
    // then fire 3 extendRoots concurrently via `all(...)`. Without the
    // queue+drain fix, those 3 extends would race into store.prefill from
    // separate fibers and I1 would fail.
    const flatOrchestrator = function* (ctx: PoolContext): Operation<void> {
      const specs = [0, 1, 2].map(i => ({
        content: `Task ${i}`,
        systemPrompt: 'You are an agent.',
        seed: i,
      }));
      const agents = yield* all(specs.map(s => ctx.spawn(s)));
      yield* all(agents.map(a => ctx.waitFor(a)));
      // The critical bit: three concurrent extendRoot calls. Before the
      // fix, each would independently hit store.prefill from its own fiber.
      yield* all([
        ctx.extendRoot('Task 0', 'Findings 0'),
        ctx.extendRoot('Task 1', 'Findings 1'),
        ctx.extendRoot('Task 2', 'Findings 2'),
      ]);
    };

    const run = await runPool({
      scripts: [
        { tokens: [1, STOP] },
        { tokens: [1, STOP] },
        { tokens: [1, STOP] },
      ],
      policy: minimalPolicy,
      orchestrate: flatOrchestrator,
    });

    // I1: no native-call temporal overlap across the entire run.
    const i1 = I1_nativeStoreSingleFiber(run);
    expect(i1.ok, i1.violations.map(v => v.detail).join('\n')).toBe(true);

    // Each extend emitted its spine:extend trace event — the drain resolved
    // the rendezvous action for every request.
    const spineExtends = run.traceEvents.filter(e => e.type === 'spine:extend');
    expect(spineExtends.length).toBe(3);

    // Each extend carried its own userContent/assistantContent.
    const descriptions = spineExtends.map(e => (e as any).userContent).sort();
    expect(descriptions).toEqual(['Task 0', 'Task 1', 'Task 2']);
  });

  it('chain-style serial extendRoot still works (no regression)', async () => {
    const chainOrchestrator = function* (ctx: PoolContext): Operation<void> {
      for (let i = 0; i < 2; i++) {
        const agent = yield* ctx.spawn({
          content: `Task ${i}`,
          systemPrompt: 'You are an agent.',
          seed: i,
        });
        yield* ctx.waitFor(agent);
        yield* ctx.extendRoot(`Task ${i}`, `Findings ${i}`);
      }
    };

    const run = await runPool({
      scripts: [
        { tokens: [1, STOP] },
        { tokens: [1, STOP] },
      ],
      taskCount: 2,
      policy: minimalPolicy,
      orchestrate: chainOrchestrator,
    });

    const i1 = I1_nativeStoreSingleFiber(run);
    expect(i1.ok).toBe(true);

    const spineExtends = run.traceEvents.filter(e => e.type === 'spine:extend');
    expect(spineExtends.length).toBe(2);
  });

  it('tick loop does not exit before final extend drains', async () => {
    // After the last spawn+wait, fire one extend and let the orchestrator
    // return. The tick loop must drain the extend before terminating —
    // otherwise the action() suspends forever and the run hangs.
    const lateExtendOrchestrator = function* (ctx: PoolContext): Operation<void> {
      const agent = yield* ctx.spawn({
        content: 'Task',
        systemPrompt: 'You are an agent.',
        seed: 0,
      });
      yield* ctx.waitFor(agent);
      // Orchestrator returns immediately after this line; the tick loop
      // must still drain before exiting.
      yield* ctx.extendRoot('Task', 'Findings');
    };

    const run = await runPool({
      scripts: [{ tokens: [1, STOP] }],
      policy: minimalPolicy,
      orchestrate: lateExtendOrchestrator,
    });

    const spineExtends = run.traceEvents.filter(e => e.type === 'spine:extend');
    expect(spineExtends.length).toBe(1);
  });
});
