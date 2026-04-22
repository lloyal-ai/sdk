/**
 * Scenario: useAgentPool validates `hardLimit >= nBatch` at startup.
 *
 * When `pressure.critical` fires, the kill path invokes `recoverInline`
 * which prefills + decodes within the `hardLimit` reserve. If hardLimit
 * is smaller than the context's nBatch (native batch allocation size),
 * recovery's decode will OOM with "no memory slot for batch of size N".
 *
 * The invariant: `hardLimit >= nBatch` is enforced at pool startup via
 * a throw. Users who want recovery must configure hardLimit explicitly
 * to at least the context's nBatch (default 512).
 *
 * What this locks:
 *   - Misconfiguration is caught at `useAgentPool` entry, not at runtime
 *     OOM-crash time.
 *   - The error message names the invariant and how to fix it.
 */
import { describe, it, expect } from 'vitest';
import { DefaultAgentPolicy } from '../../../src/AgentPolicy';
import { runPool } from '../harness';

describe('scenario: hardLimit >= nBatch invariant', () => {
  it('hardLimit=128 < nBatch=512 → pool startup throws with Invariant Violation', async () => {
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      budget: { context: { softLimit: 1024, hardLimit: 128 } },  // TOO LOW
    });

    await expect(runPool({
      nCtx: 4096,
      scripts: [{ tokens: [1, 999] }],
      policy,
    })).rejects.toThrow(/Invariant Violation/);
  });

  it('hardLimit=512 = nBatch=512 → pool starts cleanly', async () => {
    const policy = new DefaultAgentPolicy({
      terminalTool: 'report',
      budget: { context: { softLimit: 1024, hardLimit: 512 } },
    });

    // Doesn't throw — agent runs normally.
    const run = await runPool({
      nCtx: 4096,
      scripts: [{ tokens: [1, 999], content: 'done' }],
      policy,
    });
    expect(run.result.agents.length).toBe(1);
  });
});
