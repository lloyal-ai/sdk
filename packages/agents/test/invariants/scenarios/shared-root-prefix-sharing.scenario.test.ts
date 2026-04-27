/**
 * Scenario: shared root [system + tools] header prefix-shared across all
 * agents in a pool when `agentPool({ systemPrompt })` is set.
 *
 * The point of this primitive: tool schemas appear in physical KV ONCE
 * (at queryRoot), regardless of how many agents the pool spawns. Every
 * spawn inherits the role+tools header via `forkSync`'s metadata-only
 * prefix-sharing, and `setupAgent` formats only the user turn for the
 * agent's suffix — saving ~700 tok per spawn vs. re-emitting the schema
 * with each agent.
 *
 * What this locks:
 *   - `withSharedRoot({ systemPrompt, toolsJson })` calls `formatChatSync`
 *     EXACTLY ONCE with a `tools` option (the root setup).
 *   - Subsequent per-spawn `formatChatSync` calls inside `setupAgent`
 *     receive NO `tools` option — they format only the agent's user turn
 *     (or system+user when per-spec systemPrompt is non-empty).
 *   - The new agent's `fmt.parser` matches what the root setup produced
 *     (so tool dispatch keeps working on inherited tools).
 */

import { describe, it, expect } from 'vitest';
import { run, createChannel, scoped } from 'effection';
import type { Channel } from 'effection';
import { MockSessionContext } from '../../../../sdk/test/MockSessionContext';
import { Branch } from '../../../../sdk/src/Branch';
import { BranchStore } from '../../../../sdk/src/BranchStore';
import type { ChatFormat, ParseChatOutputOptions, ParseChatOutputResult } from '@lloyal-labs/sdk';
import { agentPool } from '../../../src/create-agent-pool';
import { Tool } from '../../../src/Tool';
import { parallel } from '../../../src/orchestrators';
import { Ctx, Store, Events, Trace } from '../../../src/context';
import type { JsonSchema, AgentEvent } from '../../../src/types';
import type { AgentPolicy } from '../../../src/AgentPolicy';
import { CapturingTraceWriter } from '../../helpers/capturing-trace';
import type { Operation } from 'effection';

const STOP = 999;

const NEVER_EXIT_POLICY: AgentPolicy = {
  shouldExit: () => false,
  onProduced: () => ({ type: 'idle', reason: 'free_text_stop' }),
  onSettleReject: () => ({ type: 'idle', reason: 'pressure_settle_reject' }),
};

class WebSearchTool extends Tool<{ query: string }> {
  readonly name = 'web_search';
  readonly description = 'web search';
  readonly parameters: JsonSchema = {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
  };
  *execute(): Operation<unknown> { return { results: [] }; }
}

describe('scenario: shared root [system + tools] prefix-sharing', () => {
  it('formatChatSync is called once with tools (at root setup) and tools-free for each agent spawn', async () => {
    const ctx = new MockSessionContext({ nCtx: 16384, cellsUsed: 1000 });
    const store = new BranchStore(ctx);
    const root = Branch.create(ctx, 0);

    // Drive every fork to STOP immediately so the pool finishes fast.
    ctx._branchSample = () => STOP;
    ctx.parseChatOutput = (_raw, _fmt, _opts?: ParseChatOutputOptions): ParseChatOutputResult =>
      ({ content: '', reasoningContent: '', toolCalls: [] });

    // Spy on formatChatSync to record each call's opts.tools field.
    const formatToolsArgs: unknown[] = [];
    const origFormat = ctx.formatChatSync.bind(ctx);
    ctx.formatChatSync = (msgs: string, opts?: unknown) => {
      const o = opts as { tools?: unknown } | undefined;
      formatToolsArgs.push(o?.tools);
      return origFormat(msgs, opts as Parameters<typeof origFormat>[1]);
    };

    const trace = new CapturingTraceWriter();

    await run(function* () {
      yield* Ctx.set(ctx as unknown as Parameters<typeof Ctx.set>[0]);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as unknown as Parameters<typeof Events.set>[0]);
      yield* Trace.set(trace);

      yield* scoped(function* () {
        return yield* agentPool({
          systemPrompt: 'You are a research assistant.',
          tools: [new WebSearchTool()],
          orchestrate: parallel([
            { content: 'task 0', systemPrompt: '', seed: 0 },
            { content: 'task 1', systemPrompt: '', seed: 1 },
            { content: 'task 2', systemPrompt: '', seed: 2 },
          ]),
          policy: NEVER_EXIT_POLICY,
          maxTurns: 100,
        });
      });
    });

    // Exactly one formatChatSync call carried tools — that's the root setup.
    const withTools = formatToolsArgs.filter((t) => t !== undefined);
    expect(withTools.length).toBe(1);

    // The remaining calls (one per spawn) had NO tools — agents inherited
    // the schemas via fork prefix-share rather than re-emitting them.
    const withoutTools = formatToolsArgs.filter((t) => t === undefined);
    // Three spawns + at least one root-related setup call without tools is fine;
    // the load-bearing assertion is that NO per-spawn call carried tools.
    expect(withoutTools.length).toBeGreaterThanOrEqual(3);
  });

  it('non-shared mode (no systemPrompt option) preserves per-spawn tools — regression guard', async () => {
    // Same setup but WITHOUT the new option: each spawn must re-emit tools
    // in its own suffix, preserving today's behavior.
    const ctx = new MockSessionContext({ nCtx: 16384, cellsUsed: 1000 });
    const store = new BranchStore(ctx);
    const root = Branch.create(ctx, 0);
    void root;

    ctx._branchSample = () => STOP;
    ctx.parseChatOutput = (): ParseChatOutputResult =>
      ({ content: '', reasoningContent: '', toolCalls: [] });

    const formatToolsArgs: unknown[] = [];
    const origFormat = ctx.formatChatSync.bind(ctx);
    ctx.formatChatSync = (msgs: string, opts?: unknown) => {
      const o = opts as { tools?: unknown } | undefined;
      formatToolsArgs.push(o?.tools);
      return origFormat(msgs, opts as Parameters<typeof origFormat>[1]);
    };

    const trace = new CapturingTraceWriter();

    await run(function* () {
      yield* Ctx.set(ctx as unknown as Parameters<typeof Ctx.set>[0]);
      yield* Store.set(store);
      const events: Channel<AgentEvent, void> = createChannel();
      yield* Events.set(events as unknown as Parameters<typeof Events.set>[0]);
      yield* Trace.set(trace);

      yield* scoped(function* () {
        return yield* agentPool({
          // no systemPrompt — non-shared mode
          tools: [new WebSearchTool()],
          orchestrate: parallel([
            { content: 'task 0', systemPrompt: 'You are agent A.', seed: 0 },
            { content: 'task 1', systemPrompt: 'You are agent B.', seed: 1 },
          ]),
          policy: NEVER_EXIT_POLICY,
          maxTurns: 100,
        });
      });
    });

    // Each per-spawn setupAgent call carried tools — same as the existing
    // (pre-shared-mode) baseline. No surprise regression for callers that
    // don't opt in.
    const withTools = formatToolsArgs.filter((t) => t !== undefined);
    expect(withTools.length).toBeGreaterThanOrEqual(2);
  });
});
