/**
 * Scenario: SETTLE-phase nudge via policy.onSettleReject
 *
 * Shape: single agent, one tool call, oversized tool result, policy's
 * onSettleReject returns { type: 'nudge' }. The framework should:
 *
 *   1. Consult policy.onSettleReject when the tool result can't fit.
 *   2. Emit `pool:agentNudge reason=settle_reject` with the policy's message.
 *   3. Replace the oversized result with a compact nudge payload.
 *   4. Defer the nudge to the next tick's SETTLE.
 *   5. NOT drop the agent with `settle_stall_break` (stall-break is
 *      reserved for the "no alternatives remain" path — here the policy
 *      IS the alternative).
 *
 * This invariant is I24 (policy consulted) + the nudge-reason contract.
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
  private readonly _payload: string;

  constructor(charCount: number) {
    super();
    // String length controls tokens via MockSessionContext.tokenizeSync:
    // Math.ceil(text.length / 4) tokens per string.
    this._payload = 'x'.repeat(charCount);
  }

  *execute(): Operation<unknown> {
    return { results: [this._payload] };
  }
}

describe('scenario: pressure exit via SETTLE-phase policy nudge', () => {
  it('oversized result + onSettleReject→nudge → pool:agentNudge reason=settle_reject', async () => {
    const bigTool = new BigResultTool(8000);  // ~2000+ tokens when serialized
    const tools = new Map<string, Tool>([['web_search', bigTool]]);

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

    // nCtx 4096, cellsUsed 3000 → remaining 1096, softLimit 1024 → headroom 72.
    // An 8000-char payload is ~2000 tokens when tokenized — vastly exceeds 72.
    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"test"}' },
      }],
      policy,
      tools,
      terminalTool: 'report',
      maxTurns: 5,
    });

    // 1. Policy's onSettleReject was actually invoked (this is the I24 core).
    expect(onSettleRejectCalls).toBeGreaterThanOrEqual(1);

    // 2. Nudge event fired with the correct reason discriminator and
    //    message from the policy.
    const nudges = run.traceEvents.filter(e => e.type === 'pool:agentNudge');
    const settleNudges = nudges.filter(e => (e as any).reason === 'settle_reject');
    expect(settleNudges.length).toBeGreaterThanOrEqual(1);
    expect((settleNudges[0] as any).message).toBe('Tool result too large. Report now.');

    // 3. The agent was NOT dropped with settle_stall_break — the policy
    //    was consulted and gave us an alternative (the nudge).
    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
    const stallBreaks = drops.filter(d => (d as any).reason === 'settle_stall_break');
    expect(stallBreaks).toHaveLength(0);
  });
});
