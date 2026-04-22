/**
 * Scenario: `enableThinking` pool option propagates consistently from
 * pool setup through every delta-builder call in the tick loop.
 *
 * Prior to this fix, `setupAgent` hardcoded `enableThinking: false` while
 * `buildToolResultDelta` used the template default (typically `true` for
 * Qwen3). The agent's `fmt.generationPrompt` (used by parseChatOutput)
 * captured the setup-time value, but each tool-result prefill used a
 * DIFFERENT value — the KV state drifted from what the parser expected,
 * and models had `<think>\n` prefilled on turns 1+ only (not turn 0).
 *
 * What this locks:
 *   - `agent.fmt.enableThinking` is `false` by default (existing behavior).
 *   - Callers can override to `true` via `useAgentPool({enableThinking})`.
 *   - Whatever value is set at pool construction is stored on the agent
 *     and can be read from `run.result.agents[i].agent.fmt.enableThinking`.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { runPool, STOP } from '../harness';

describe('scenario: enableThinking propagation (pool → agent.fmt)', () => {
  const minimalPolicy: AgentPolicy = {
    onProduced: (_a, parsed) => {
      if (parsed.toolCalls.length > 0) return { type: 'tool_call', tc: parsed.toolCalls[0] };
      return { type: 'idle', reason: 'free_text_stop' };
    },
    onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
    shouldExit: () => false,
    onRecovery: () => ({ type: 'skip' }),
  };

  it('default (no enableThinking set) → agent.fmt.enableThinking = false', async () => {
    const run = await runPool({
      scripts: [{ tokens: [1, STOP] }],
      policy: minimalPolicy,
    });
    expect(run.result.agents.length).toBe(1);
    expect(run.result.agents[0].agent.fmt.enableThinking).toBe(false);
  });

  it('explicit enableThinking: true → agent.fmt.enableThinking = true', async () => {
    const run = await runPool({
      scripts: [{ tokens: [1, STOP] }],
      policy: minimalPolicy,
      enableThinking: true,
    });
    expect(run.result.agents.length).toBe(1);
    expect(run.result.agents[0].agent.fmt.enableThinking).toBe(true);
  });

  it('explicit enableThinking: false → agent.fmt.enableThinking = false', async () => {
    const run = await runPool({
      scripts: [{ tokens: [1, STOP] }],
      policy: minimalPolicy,
      enableThinking: false,
    });
    expect(run.result.agents[0].agent.fmt.enableThinking).toBe(false);
  });
});
