/**
 * Scenario: SETTLE stall-break (last-resort sacrifice)
 *
 * Shape: single agent, oversized tool result, policy's onSettleReject
 * returns { type: 'nudge' } — but the nudge payload ALSO doesn't fit
 * (pathological headroom). The framework should:
 *
 *   1. Nudge once (first consultation).
 *   2. Re-evaluate the nudge under the same tick's headroom.
 *   3. On re-evaluation: no-fit + agent already nudged → fall through
 *      to idle drop with reason=pressure_settle_reject (not another
 *      nudge — infinite-loop prevention).
 *
 * What this locks:
 *   - I25 distinction: `settle_stall_break` reason is reserved for the
 *     tick-loop's forced sacrifice when no active siblings exist AND
 *     the policy has exhausted its alternatives. In this scenario the
 *     policy said nudge, the nudge couldn't fit, we drop via the
 *     policy-path reason (not stall-break).
 *   - Infinite-nudge-loop prevention: the same agent doesn't get
 *     nudged twice in one SETTLE call.
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
  constructor(private readonly _chars: number) { super(); }
  *execute(): Operation<unknown> {
    return { results: ['x'.repeat(this._chars)] };
  }
}

describe('scenario: pressure exit via stall-break prevention', () => {
  it('nudge that itself does not fit → agent dropped, not infinite-looped', async () => {
    const bigTool = new BigResultTool(8000);
    const tools = new Map<string, Tool>([['web_search', bigTool]]);

    let nudgeCount = 0;
    const policy: AgentPolicy = {
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      onSettleReject: () => {
        nudgeCount++;
        // Pathological: returning an absurdly long message so even the
        // nudge payload exceeds headroom on re-evaluation.
        return { type: 'nudge', message: 'x'.repeat(12000) };
      },
      shouldExit: () => false,
      onRecovery: () => ({ type: 'skip' }),
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,  // headroom ~ 72
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"test"}' },
      }],
      policy,
      tools,
      terminalTool: 'report',
      maxTurns: 5,
    });

    // Policy was consulted exactly once — second pass short-circuits to idle
    // via the `alreadyNudged` guard, not a second policy call.
    expect(nudgeCount).toBe(1);

    // Agent dropped via the policy-path reason, not stall-break.
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
    const reasons = drops.map(d => (d as any).reason);
    expect(reasons).toContain('pressure_settle_reject');
    expect(reasons).not.toContain('settle_stall_break');
  });
});
