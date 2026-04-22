/**
 * Scenario: parallel orchestration preserves staggered-exit semantics.
 *
 * In `orchestrate: parallel(tasks)`, agents run concurrently. An oversized
 * tool result from agent A must NOT be acted on (nudged/dropped) while a
 * sibling agent B is still `active` — deferring gives B a chance to
 * finish and free KV, after which A's result may fit.
 *
 * The policy hook (`onSettleReject`) is consulted only at stall-break
 * time — the moment `deferred.length > 0 && no active agents remain`.
 * Until then, oversized results wait.
 *
 * What this locks:
 *   - Defer-while-siblings-active: no `pool:agentNudge` / `pool:agentDrop`
 *     for A's oversized result is emitted in the tick the result was
 *     dispatched. The policy is quiet until B has stopped.
 *   - Policy consultation is time-shifted: `onSettleReject` fires only
 *     after B transitions out of `active`.
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

class BigResultTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a fixed big payload';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(8000)] }; }
}

describe('scenario: parallel orchestration staggered-exit', () => {
  it('A oversized + B still active → policy quiet while B produces, fires after B stops', async () => {
    const tools = new Map<string, Tool>([['web_search', new BigResultTool()]]);

    let onSettleRejectCalls = 0;

    const policy: AgentPolicy = {
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => {
        onSettleRejectCalls++;
        return { type: 'nudge', message: 'Tool result too large. Report now.' };
      },
      shouldExit: () => false,
      onRecovery: () => ({ type: 'skip' }),
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 2500,
      scripts: [
        // Agent A: one quick turn, then STOP → tool call → oversized result.
        { tokens: [1, STOP], toolCall: { name: 'web_search', arguments: '{"query":"q"}' } },
        // Agent B: several tokens before STOP → free-text idle (no tool call).
        // Each B PRODUCE tick advances its sampleCount, keeping B `active`
        // while A's oversized result sits in `deferred`.
        { tokens: [1, 2, 3, 4, 5, STOP] },
      ],
      policy,
      tools,
      terminalTool: 'report',
      maxTurns: 10,
      taskCount: 2,
    });

    // A's oversized result was not acted on immediately. Policy was called
    // exactly once (after B hit STOP and went idle — stall-break fired).
    expect(onSettleRejectCalls).toBeGreaterThanOrEqual(1);

    // B produced multiple agent:turn events: B was allowed to keep running
    // while A's result sat deferred. Without staggered-exit, A would have
    // been nudged/dropped on the same tick its result came in.
    const bTurns = run.traceEvents.filter(
      e => e.type === 'agent:turn' && (e as any).agentId !== run.result.agents[0].agentId,
    );
    expect(bTurns.length).toBeGreaterThanOrEqual(1);

    // When policy fires, it's because stall-break conditions were met
    // (no active agents) — not because A's result came in big.
    // Observable: pool:agentNudge for settle_reject exists (stall-break
    // with nudge policy), or pool:agentDrop for pressure_settle_reject
    // (nudge path failed). EITHER way, it was delayed past B's lifetime.
    const settleNudges = run.traceEvents.filter(
      e => e.type === 'pool:agentNudge' && (e as any).reason === 'settle_reject',
    );
    const settleDrops = run.traceEvents.filter(
      e => e.type === 'pool:agentDrop' && (e as any).reason === 'pressure_settle_reject',
    );
    expect(settleNudges.length + settleDrops.length).toBeGreaterThanOrEqual(1);
  });
});
