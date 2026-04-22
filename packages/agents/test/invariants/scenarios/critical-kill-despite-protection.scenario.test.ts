/**
 * Scenario: pressure.critical kills mid-terminal-tool when protection
 * is narrowed to the graceful zone.
 *
 * Post-fix `DefaultAgentPolicy.shouldExit` only protects agents with
 * `currentTool === terminalTool` while `!pressure.critical`. Once
 * critical fires, protection yields and the kill proceeds.
 *
 * What this locks:
 *   - `pool:agentDrop reason=pressure_critical` fires on a mid-terminal-
 *     tool agent when remaining drops below hardLimit.
 *   - Protection no longer swallows `pressure.critical` (the DOJ runaway
 *     pattern is structurally impossible).
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { runPool } from '../harness';

describe('scenario: critical kill despite terminal-tool protection', () => {
  it('currentTool=report + remaining<hardLimit → pressure_critical drop (not protected)', async () => {
    // Tight envelope so pressure crosses hardLimit mid-run. softLimit=5
    // keeps the prefill-gate headroom wide enough to admit the agent.
    // absoluteFloor=5 (below hardLimit=30) ensures we test the critical
    // path, not the absolute-floor path.
    // softLimit=20, hardLimit=512 (minimum satisfying hardLimit >= nBatch).
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      budget: { context: { softLimit: 20, hardLimit: 512 } },
    });

    // nCtx=700: after root prefill (~4) + suffix (~27) → cellsUsed ≈ 31,
    // remaining ≈ 669. Each tick commits 1 token. After ~158 ticks,
    // remaining drops below hardLimit=512 and pressure.critical fires.
    //
    // Pre-fix: shouldExit returned false unconditionally when
    // currentTool === terminalTool; `??` swallowed the critical signal.
    // Post-fix: shouldExit's protection yields in critical; drop fires.
    const run = await runPool({
      nCtx: 700,
      cellsUsed: 0,
      scripts: [{
        // 200 non-stop tokens — enough runway for pressure to enter critical.
        tokens: [...Array.from({ length: 200 }, (_, i) => (i % 900) + 1), 999],
        // Latch currentTool='report' on the first partial-parse via observe().
        partialToolCall: { name: 'report', arguments: '{"result":"x"}' },
        toolCall: { name: 'report', arguments: '{"result":"x"}' },
      }],
      policy,
      terminalTool: 'report',
    });

    const drops = run.traceEvents.filter(e => e.type === 'pool:agentDrop');
    const reasons = drops.map(d => (d as any).reason);

    // The agent must have been killed by pressure_critical. Pre-fix,
    // shouldExit's unconditional `return false` for currentTool===terminalTool
    // + the `??` semantics swallowed pressure.critical. Post-fix, protection
    // yields in critical territory → pressure_critical drop fires.
    expect(reasons).toContain('pressure_critical');
  });
});
