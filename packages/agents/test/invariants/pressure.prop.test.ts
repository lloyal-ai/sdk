/**
 * Property tests for pressure-driven agent exits.
 *
 * I24: policy.onSettleReject is invoked at least once for every run that
 *      produces a `pool:agentDrop reason=pressure_settle_reject` event.
 *      (The hook existed as interface + default impl but was never called
 *      from agent-pool.ts before this test suite landed.)
 *
 * I25: `settle_stall_break` is never emitted when the policy returned
 *      `{type: 'nudge'}` and the nudge fits in headroom. Stall-break is
 *      reserved for the case where the policy has exhausted alternatives.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { Tool } from '../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../src/types';
import type { AgentPolicy } from '../../src/AgentPolicy';
import { runPool, STOP } from './harness';

class SizedTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'tool with configurable result size';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  constructor(private readonly _chars: number) { super(); }
  *execute(): Operation<unknown> { return { results: ['x'.repeat(this._chars)] }; }
}

describe('property: pressure-driven exits', () => {
  it('I24 — onSettleReject invoked whenever a pressure_settle_reject drop occurs', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Result size: small (fits), borderline, or oversized.
        fc.integer({ min: 100, max: 12000 }),
        // Initial pressure: low-to-high range.
        fc.integer({ min: 1000, max: 3500 }),
        async (resultChars, cellsUsed) => {
          let onSettleRejectCalls = 0;
          const policy: AgentPolicy = {
            onProduced: (_a, parsed) => {
              if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
              return { type: 'idle', reason: 'free_text_stop' };
            },
            onSettleReject: () => {
              onSettleRejectCalls++;
              return { type: 'idle', reason: 'pressure_settle_reject' };
            },
            shouldExit: () => false,
            onRecovery: () => ({ type: 'skip' }),
          };

          const run = await runPool({
            nCtx: 4096,
            cellsUsed,
            scripts: [{
              tokens: [1, STOP],
              toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
            }],
            policy,
            tools: new Map<string, Tool>([['web_search', new SizedTool(resultChars)]]),
            terminalTool: 'report',
            maxTurns: 3,
          });

          const settleDrops = run.traceEvents.filter(
            e => e.type === 'pool:agentDrop'
              && (e as any).reason === 'pressure_settle_reject',
          );

          // Invariant: any pressure_settle_reject drop implies the policy
          // was consulted.
          if (settleDrops.length > 0) {
            return onSettleRejectCalls >= 1;
          }
          return true;  // no drop → invariant trivially holds
        },
      ),
      { numRuns: 30, seed: 42 },
    );
  });

  it('I25 — nudge-that-fits never causes settle_stall_break', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 3000, max: 10000 }),   // oversized result
        fc.integer({ min: 1500, max: 3000 }),    // cellsUsed
        async (resultChars, cellsUsed) => {
          const policy: AgentPolicy = {
            onProduced: (_a, parsed) => {
              if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
              return { type: 'idle', reason: 'free_text_stop' };
            },
            // Short nudge message — will fit in headroom easily.
            onSettleReject: () => ({ type: 'nudge', message: 'report now' }),
            shouldExit: () => false,
            onRecovery: () => ({ type: 'skip' }),
          };

          const run = await runPool({
            nCtx: 4096,
            cellsUsed,
            scripts: [{
              tokens: [1, STOP],
              toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
            }],
            policy,
            tools: new Map<string, Tool>([['web_search', new SizedTool(resultChars)]]),
            terminalTool: 'report',
            maxTurns: 3,
          });

          const stallBreaks = run.traceEvents.filter(
            e => e.type === 'pool:agentDrop' && (e as any).reason === 'settle_stall_break',
          );
          return stallBreaks.length === 0;
        },
      ),
      { numRuns: 30, seed: 7 },
    );
  });
});
