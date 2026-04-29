/**
 * Scenario: recoverInline produces unparseable output → pool:recoveryFailed
 *
 * Shape: agent emits tool call, result oversized, policy says idle →
 * agent dropped → recoverInline runs → produces a non-JSON string →
 * JSON.parse throws → failure is visible in the trace (not silent).
 *
 * What this locks:
 *   - I29: recovery diagnostic completeness. Every recovery attempt that
 *     prefills a recovery prompt must terminate with exactly one of
 *     `pool:recoveryReport` or `pool:recoveryFailed`.
 *   - Failure reason + output excerpt are captured so ops can diagnose
 *     why a recovery failed without re-running the job.
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
  *execute(): Operation<unknown> {
    return { results: ['x'.repeat(8000)] };
  }
}

describe('scenario: recovery generates unparseable output', () => {
  it('drop → recoverInline produces non-JSON → pool:recoveryFailed with excerpt', async () => {
    const tools = new Map<string, Tool>([['web_search', new BigResultTool()]]);

    const policy: AgentPolicy = {
      onProduced: (_a, parsed) => {
        if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
        return { type: 'idle', reason: 'free_text_stop' };
      },
      // Policy chooses idle drop over nudge, forcing recoverInline to run.
      onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
      // Recovery is enabled (not skip) so the produce/commit loop runs.
      onRecovery: () => ({ type: 'extract', prompt: { system: 's', user: 'u' } }),
      shouldExit: () => false,
    };

    const run = await runPool({
      nCtx: 4096,
      cellsUsed: 3000,
      // Script: [1, STOP] for the initial turn, then [2, 3, STOP] for
      // the recovery produce loop. MockSessionContext.tokenToText emits
      // "t2", "t3" — concatenates to "t2t3", which is not JSON.
      scripts: [{
        tokens: [1, STOP, 2, 3, STOP],
        toolCall: { name: 'web_search', arguments: '{"query":"q"}' },
      }],
      policy,
      tools,
      terminalTool: 'report',
      maxTurns: 5,
    });

    // Recovery prefill happened.
    const recoveryPrefills = run.traceEvents.filter(
      e => e.type === 'branch:prefill' && (e as any).role === 'recovery',
    );
    expect(recoveryPrefills.length).toBeGreaterThanOrEqual(1);

    // Every recovery prefill is followed by exactly one diagnostic event.
    const reports = run.traceEvents.filter(e => e.type === 'pool:recoveryReport');
    const failures = run.traceEvents.filter(e => e.type === 'pool:recoveryFailed');
    expect(reports.length + failures.length).toBe(recoveryPrefills.length);

    // This specific run must have produced a failure (non-JSON output).
    expect(failures.length).toBeGreaterThanOrEqual(1);
    const f = failures[0] as any;
    expect(f.reason).toMatch(/parse_error/);
    expect(typeof f.outputExcerpt).toBe('string');
    expect(f.outputExcerpt.length).toBeGreaterThan(0);
  });
});
