/**
 * Scenario: recovery prompt renders `<%= it.budget %>` with the live budget.
 *
 * When the policy's recovery prompt contains eta tags, they are rendered
 * at `onRecovery` call time with a context containing the computed budget:
 *   `budget = max(50, pressure.remaining - RECOVERY_PREFILL_OVERHEAD - BATCH_BUFFER)`.
 *
 * What this locks:
 *   - `DefaultAgentPolicy.onRecovery` invokes eta templating on both the
 *     system and user strings.
 *   - The rendered strings contain the numeric budget (no `<%= %>` tags
 *     leak through — they get substituted).
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy, ContextPressure } from '../../../src/index';

// Build a pressure snapshot via the real class, without running a pool.
// onRecovery is a pure policy method — easier to test directly than
// threading through the full pool/harness machinery.
function mkPressure(remaining: number): ContextPressure {
  return new ContextPressure(
    {
      _storeKvPressure: () => ({ nCtx: 16384, cellsUsed: 16384 - remaining, remaining }),
    } as any,
    { softLimit: 1024, hardLimit: 128, absoluteFloor: 512 },
  );
}

describe('scenario: recovery prompt budget substitution', () => {
  it('renders <%= it.budget %> with the computed word budget', () => {
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      recovery: {
        prompt: {
          system: 'You have <%= it.budget %> words to report.',
          user: 'Report within <%= it.budget %>.',
        },
        minTokens: 0,
        minToolCalls: 0,
      },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // pressure(remaining=2000) → budgetTokens = max(50, 2000-150-512) = 1338
    // → words = floor(1338 * 0.7 / 10) * 10 = floor(93.66) * 10 = 930
    const action = policy.onRecovery(agent, mkPressure(2000));
    expect(action.type).toBe('extract');
    const extract = action as { type: 'extract'; prompt: { system: string; user: string } };
    expect(extract.prompt.system).toBe('You have 930 words to report.');
    expect(extract.prompt.user).toBe('Report within 930.');

    // No eta tags survive in the output.
    expect(extract.prompt.system).not.toContain('<%=');
    expect(extract.prompt.user).not.toContain('<%=');
  });

  it('floors the word budget at 10 for pathologically low remaining', () => {
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      recovery: {
        prompt: {
          system: 'Budget: <%= it.budget %>',
          user: 'Report.',
        },
        minTokens: 0,
        minToolCalls: 0,
      },
    });

    const agent: any = { tokenCount: 200, toolCallCount: 5 };

    // remaining=100 → budgetTokens = max(50, 100-150-512) = 50
    // → words = max(10, floor(50 * 0.7 / 10) * 10) = max(10, 30) = 30
    const action = policy.onRecovery(agent, mkPressure(100));
    const extract = action as { type: 'extract'; prompt: { system: string; user: string } };
    expect(extract.prompt.system).toBe('Budget: 30');
  });
});
