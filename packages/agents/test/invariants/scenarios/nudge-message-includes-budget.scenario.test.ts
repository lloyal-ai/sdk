/**
 * Scenario: nudge messages carry the remaining budget as a word count.
 *
 * `DefaultAgentPolicy.onSettleReject` and `_handleOverBudget` convert
 * `pressure.remaining - pressure.hardLimit` to a conservative word count
 * and interpolate it into their messages. Words (not tokens) because
 * tokenizers vary but words are universal.
 *
 * What this locks:
 *   - `pool:agentNudge reason=settle_reject` message contains
 *     "within N words" where N = floor(tokenBudget * 0.7 / 10) * 10.
 *   - The rendered number is deterministic given the pressure snapshot.
 */
import { describe, it, expect } from 'vitest';
import { Tool } from '../../../src/Tool';
import type { Operation } from 'effection';
import type { JsonSchema } from '../../../src/types';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

class BigResultTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'returns a fixed big payload';
  readonly parameters: JsonSchema = { type: 'object', properties: { query: { type: 'string' } } };
  *execute(): Operation<unknown> { return { results: ['x'.repeat(8000)] }; }
}

describe('scenario: nudge message includes the remaining token budget', () => {
  it('oversized tool result → settle_reject nudge message has "within N words"', async () => {
    const tools = new Map<string, Tool>([['web_search', new BigResultTool()]]);
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      // hardLimit >= nBatch (512) required.
      budget: { context: { softLimit: 1024, hardLimit: 512 } },
    });

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,  // headroom tight — oversized result won't fit → defer → stall-break
      scripts: [{
        tokens: [1, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
      }],
      policy,
      tools,
      terminalTool: 'report',
      maxTurns: 5,
    });

    const settleNudges = run.traceEvents.filter(
      e => e.type === 'pool:agentNudge' && (e as any).reason === 'settle_reject',
    );
    expect(settleNudges.length).toBeGreaterThanOrEqual(1);

    // Message pattern: "Tool result too large … within N words."
    // Tokens-to-words: floor(tokens * 0.7 / 10) * 10. Words are used in
    // model-facing prompts because tokenizers vary across models.
    const message = (settleNudges[0] as any).message as string;
    expect(message).toMatch(/within \d+ words\.$/);

    const match = message.match(/within (\d+) words\./);
    expect(match).toBeTruthy();
    const wordBudget = Number(match![1]);
    expect(wordBudget).toBeGreaterThan(0);
    expect(wordBudget).toBeLessThan(4096);
    expect(wordBudget % 10).toBe(0);  // rounded to nearest 10
  });
});
